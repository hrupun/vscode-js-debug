// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugAdapter, DebugAdapterDelegate } from '../adapter/debugAdapter';
import { SourcePathResolver, InlineScriptOffset } from '../adapter/sources';
import { Target } from '../adapter/targets';
import Cdp from '../cdp/api';
import Connection from '../cdp/connection';
import { PipeTransport } from '../cdp/transport';
import Dap from '../dap/api';
import * as utils from '../utils/urlUtils';
import { ThreadDelegate, Thread } from '../adapter/threads';

export interface LaunchParams extends Dap.LaunchParams {
  command: string;
  cwd: string;
  env: Object;
  attachToNode: ['never', 'always', 'top-level'];
}

let counter = 0;

export class NodeDelegate implements DebugAdapterDelegate {
  private _rootPath: string | undefined;
  private _server: net.Server | undefined;
  private _runtime: ChildProcess | undefined;
  private _connections: Connection[] = [];
  private _launchParams: LaunchParams | undefined;
  private _pipe: string | undefined;
  private _isRestarting: boolean;
  _debugAdapter: DebugAdapter;
  _targets = new Map<string, NodeTarget>();
  _pathResolver: NodeSourcePathResolver;

  constructor(debugAdapter: DebugAdapter, rootPath: string | undefined) {
    this._debugAdapter = debugAdapter;
    this._rootPath = rootPath;
    debugAdapter.addDelegate(this);
  }

  async onLaunch(params: Dap.LaunchParams): Promise<Dap.LaunchResult | Dap.Error> {
    // params.noDebug
    this._launchParams = params as LaunchParams;
    this._pathResolver = new NodeSourcePathResolver(this._rootPath);
    await this._startServer();
    await this._relaunch();
    return {};
  }

  async _relaunch() {
    await this._killRuntime();

    const { shell, param } = process.platform === 'win32' ?
        { shell: 'cmd', param: '/C' } :
        { shell: '/bin/sh', param: '-c' };
    const commandLine = this._launchParams!.command;
    this._runtime = spawn(shell, [param, commandLine], {
      cwd: this._launchParams!.cwd || this._rootPath,
      env: this._buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output: vscode.OutputChannel | undefined = vscode.window.createOutputChannel(commandLine);
    output.show();
    this._runtime.stdout.on('data', data => output && output.append(data.toString()));
    this._runtime.stderr.on('data', data => output && output.append(data.toString()));
    this._runtime.on('exit', () => {
      output = undefined;
      this._runtime = undefined;
      if (!this._isRestarting) {
        this._stopServer();
        this._debugAdapter.removeDelegate(this);
      }
    });
  }

  async onTerminate(params: Dap.TerminateParams): Promise<Dap.TerminateResult | Dap.Error> {
    await this._killRuntime();
    await this._stopServer();
    return {};
  }

  async onDisconnect(params: Dap.DisconnectParams): Promise<Dap.DisconnectResult | Dap.Error> {
    await this._killRuntime();
    await this._stopServer();
    return {};
  }

  async _killRuntime() {
    if (!this._runtime || this._runtime.killed)
      return;
    this._runtime.kill();
    let callback = () => {};
    const result = new Promise(f => callback = f);
    this._runtime.on('exit', callback);
    return result;
  }

  async onRestart(params: Dap.RestartParams): Promise<Dap.RestartResult | Dap.Error> {
    // Dispose all the connections - Node would not exit child processes otherwise.
    this._isRestarting = true;
    await this._killRuntime();
    this._stopServer();
    await this._startServer();
    await this._relaunch();
    this._isRestarting = false;
    return {};
  }

  _startServer() {
    const pipePrefix = process.platform === 'win32' ? '\\\\.\\pipe\\' : os.tmpdir();
    this._pipe = path.join(pipePrefix, `node-cdp.${process.pid}-${++counter}.sock`);
    this._server = net.createServer(socket => {
      this._startSession(socket);
    }).listen(this._pipe);
  }

  _stopServer() {
    if (this._server)
      this._server.close();
    this._server = undefined;
    this._connections.forEach(c => c.close());
    this._connections = [];
  }

  async _startSession(socket: net.Socket) {
    const connection = new Connection(new PipeTransport(socket));
    this._connections.push(connection);
    const cdp = connection.createSession('');
    const { targetInfo } = await new Promise<Cdp.Target.TargetCreatedEvent>(f => cdp.Target.on('targetCreated', f));
    new NodeTarget(this, connection, cdp, targetInfo);
    this._debugAdapter.fireTargetForestChanged();
  }

  targetForest(): Target[] {
    return Array.from(this._targets.values()).filter(t => !t.hasParent()).map(t => t.toTarget());
  }

  adapterDisposed() {
    this._stopServer();
  }

  _buildEnv(): Object {
    const bootloaderJS = path.join(__dirname, 'bootloader.js');
    let result: Object = {
      ...process.env,
      ...this._launchParams!.env || {},
      NODE_INSPECTOR_IPC: this._pipe,
      NODE_INSPECTOR_WAIT_FOR_DEBUGGER: this._launchParams!.attachToNode || 'never',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS|| ''} --require ${bootloaderJS}`,
    };
    delete result['ELECTRON_RUN_AS_NODE'];
    return result;
  }
}

class NodeTarget implements ThreadDelegate {
  private _delegate: NodeDelegate;
  private _connection: Connection;
  private _cdp: Cdp.Api;
  private _parent: NodeTarget | undefined;
  private _children: NodeTarget[] = [];
  private _targetId: string;
  private _targetName: string;
  private _scriptName: string;
  private _serialize = Promise.resolve();
  private _thread: Thread | undefined;

  constructor(delegate: NodeDelegate, connection: Connection, cdp: Cdp.Api, targetInfo: Cdp.Target.TargetInfo) {
    this._delegate = delegate;
    this._connection = connection;
    this._cdp = cdp;
    this._targetId = targetInfo.targetId;
    this._scriptName = targetInfo.title;
    if (targetInfo.title)
      this._targetName = `${path.basename(targetInfo.title)} [${targetInfo.targetId}]`;
    else
      this._targetName = `[${targetInfo.targetId}]`;

    this._setParent(delegate._targets.get(targetInfo.openerId!));
    delegate._targets.set(targetInfo.targetId, this);
    cdp.Target.on('targetDestroyed', () => this._connection.close());
    connection.onDisconnected(_ => this._disconnected());

    if (targetInfo.type === 'waitingForDebugger')
      this._attach();
  }

  copyToClipboard(text: string) {
    // TODO: move into the UIDelegate.
    vscode.env.clipboard.writeText(text);
  }

  defaultScriptOffset(): InlineScriptOffset {
    return { lineOffset: 0, columnOffset: 62 };
  }

  sourcePathResolver(): SourcePathResolver {
    return this._delegate._pathResolver;
  }

  supportsCustomBreakpoints(): boolean {
    return false;
  }

  hasParent(): boolean {
    return !!this._parent;
  }

  _setParent(parent?: NodeTarget) {
    if (this._parent)
      this._parent._children.splice(this._parent._children.indexOf(this), 1);
    this._parent = parent;
    if (this._parent)
      this._parent._children.push(this);
  }

  async _disconnected() {
    this._children.forEach(child => child._setParent(this._parent));
    this._setParent(undefined);
    this._delegate._targets.delete(this._targetId);
    await this._detach();
    this._delegate._debugAdapter.fireTargetForestChanged();
  }

  _attach() {
    this._serialize = this._serialize.then(async () => {
      if (this._thread)
        return;
      await this._doAttach();
    });
  }

  _detach() {
    this._serialize = this._serialize.then(async () => {
      if (!this._thread)
        return;
      await this._doDetach();
    });
  }

  async _doAttach() {
    await this._cdp.Target.attachToTarget({ targetId: this._targetId });
    const thread = this._delegate._debugAdapter.threadManager.createThread(this._targetId, this._cdp, this);
    thread.setName(this._targetName);
    thread.initialize();
    thread.onExecutionContextsDestroyed(context => {
      if (context.description.auxData && context.description.auxData['isDefault'])
        this._connection.close();
    });
    this._thread = thread;
    this._cdp.Runtime.runIfWaitingForDebugger({});
  }

  async _doDetach() {
    await this._cdp.Target.detachFromTarget({ targetId: this._targetId });
    const thread = this._thread!;
    this._thread = undefined;
    thread.dispose();
  }

  _stop() {
    process.kill(+this._targetId);
    this._connection.close();
  }

  toTarget(): Target {
    return {
      id: this._targetId,
      name: this._targetName,
      fileName: this._scriptName,
      children: this._children.map(t => t.toTarget()),
      type: 'node',
      thread: this._thread,
      stop: () => this._stop(),
      attach: this._thread ? undefined : () => this._attach(),
      detach: this._thread ? () => this._detach() : undefined
    };
  }
}

class NodeSourcePathResolver implements SourcePathResolver {
  private _rootPath: string | undefined;

  constructor(rootPath: string | undefined) {
    this._rootPath = rootPath;
  }

  rewriteSourceUrl(sourceUrl: string): string {
    // See BrowserSourcePathResolver for explanation of this heuristic.
    if (this._rootPath && sourceUrl.startsWith(this._rootPath) && !utils.isValidUrl(sourceUrl))
      return utils.absolutePathToFileUrl(sourceUrl) || sourceUrl;
    return sourceUrl;
  }

  urlToAbsolutePath(url: string): string {
    return utils.fileUrlToAbsolutePath(url) || '';
  }

  absolutePathToUrl(absolutePath: string): string | undefined {
    return utils.absolutePathToFileUrl(path.normalize(absolutePath));
  }

  scriptUrlToUrl(url: string): string {
    const isPath = url[0] === '/' || (process.platform === 'win32' && url[1] === ':' && url[2] === '\\');
    return isPath ? (utils.absolutePathToFileUrl(url) || url) : url;
  }

  shouldCheckContentHash(): boolean {
    // Node executes files directly from disk, there is no need to check the content.
    return false;
  }
}