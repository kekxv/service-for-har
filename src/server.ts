#!/usr/bin/env node
import http, { IncomingMessage, ServerResponse } from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { URL, URLSearchParams } from 'url';
import { deepEqual } from 'assert';
import chalk from 'chalk';
import formidable from 'formidable';
import crypto from 'crypto';
import { convertSazToHar } from './saz-converter.js';

// --- 类型定义 ---
interface HarHeader { name: string; value: string; }
interface HarPostData { mimeType: string; text?: string; params?: Array<{ name: string; value: string }>; }
interface HarContent { text?: string; encoding?: 'base64' | string; mimeType: string; }
interface HarResponse { status: number; statusText: string; headers: HarHeader[]; content: HarContent; }
interface HarRequest { method: string; url: string; headers: HarHeader[]; postData?: HarPostData; }
interface HarEntry { request: HarRequest; response: HarResponse; }
interface HarLog { entries: HarEntry[]; }
interface HarFile { log: HarLog; }
interface ReplayState { entries: HarEntry[]; currentIndex: number; }

class HarReplayServer {
    private port: number;
    private sources: string[];
    private storageDir: string;
    private harDataMap: Map<string, Map<string, ReplayState>> = new Map();
    private loadedHarFiles: string[] = [];
    private lastReloadTimestamp: Date | null = null;
    private readonly METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

    constructor(initialSources: string[], storageDir: string = './har_storage', port: number = 3000) {
        this.port = port;
        this.storageDir = path.resolve(storageDir);
        this.sources = [...initialSources.map(s => path.resolve(s)), this.storageDir];
    }

    private _getFormattedTimestamp(): string {
        const d = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
               `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }
    
    private colorizeUrlPath(method: string, urlPath: string): string {
        const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp']);
        const DOC_EXTS = new Set(['.html', '.htm']);
        const SCRIPT_EXTS = new Set(['.js', '.css']);
        const FONT_EXTS = new Set(['.woff', '.woff2', '.ttf', '.eot']);
        const ext = path.extname(urlPath.toLowerCase());
        if (this.METHODS_WITH_BODY.has(method) || (method === 'GET' && ext === '')) return chalk.green(urlPath);
        if (IMAGE_EXTS.has(ext)) return chalk.magenta(urlPath);
        if (DOC_EXTS.has(ext)) return chalk.blue(urlPath);
        if (SCRIPT_EXTS.has(ext)) return chalk.cyan(urlPath);
        if (FONT_EXTS.has(ext)) return chalk.yellow(urlPath);
        if (method === 'GET') return chalk.green(urlPath);
        return urlPath;
    }
    
    private getRequestBody(req: IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => resolve(body));
            req.on('error', err => reject(err));
        });
    }

    private compareURLSearchParams(p1: URLSearchParams, p2: URLSearchParams): boolean {
        p1.sort(); p2.sort();
        return p1.toString() === p2.toString();
    }

    private compareQueryParams(reqUrl: string, harUrlStr: string): boolean {
        const reqUrlObj = new URL(reqUrl, 'http://dummy.base');
        const harUrlObj = new URL(harUrlStr, 'http://dummy.base');
        return this.compareURLSearchParams(reqUrlObj.searchParams, harUrlObj.searchParams);
    }

    private compareBody(reqBody: string, harPostData?: HarPostData): boolean {
        if (!harPostData || typeof harPostData.text !== 'string') return !reqBody;
        const harMimeType = harPostData.mimeType.split(';')[0].trim();
        const harBody = harPostData.text;
        switch (harMimeType) {
            case 'application/json':
                try {
                    deepEqual(JSON.parse(reqBody || '{}'), JSON.parse(harBody || '{}'));
                    return true;
                } catch { return false; }
            case 'application/x-www-form-urlencoded':
                return this.compareURLSearchParams(new URLSearchParams(reqBody), new URLSearchParams(harBody));
            default:
                return reqBody === harBody;
        }
    }

    private async _resolveHarFilePaths(): Promise<string[]> {
        const resolvedFiles: Set<string> = new Set();
        for (const sourcePath of this.sources) {
            try {
                const stats = await fs.stat(sourcePath);
                if (stats.isDirectory()) {
                    const filesInDir = await fs.readdir(sourcePath);
                    for (const file of filesInDir) {
                        if (file.toLowerCase().endsWith('.har')) {
                            resolvedFiles.add(path.join(sourcePath, file));
                        }
                    }
                } else if (stats.isFile() && sourcePath.toLowerCase().endsWith('.har')) {
                    resolvedFiles.add(sourcePath);
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    console.warn(chalk.yellow(`[WARN] Could not access path: ${sourcePath}. It will be ignored.`));
                }
            }
        }
        return Array.from(resolvedFiles);
    }

    private async _processSingleHarFile(harFilePath: string): Promise<void> {
        try {
            const fileContent = await fs.readFile(harFilePath, 'utf-8');
            const harJson: HarFile = JSON.parse(fileContent);
            if (!harJson.log || !harJson.log.entries) {
                console.warn(chalk.yellow(`[WARN] Invalid HAR format in file: ${harFilePath}.`));
                return;
            }
            for (const entry of harJson.log.entries) {
                if (!entry?.request?.url || !entry.response) continue;
                const method = entry.request.method.toUpperCase();
                const urlObject = new URL(entry.request.url, 'http://dummy.base');
                const urlPath = urlObject.pathname;
                const pathMap = this.harDataMap.get(method) || new Map<string, ReplayState>();
                if (!this.harDataMap.has(method)) this.harDataMap.set(method, pathMap);
                const state = pathMap.get(urlPath) || { entries: [], currentIndex: 0 };
                if (!pathMap.has(urlPath)) pathMap.set(urlPath, state);
                state.entries.push(entry);
            }
        } catch (error) {
            console.error(`[ERROR] Failed to load or parse HAR file: ${harFilePath}`, error);
        }
    }

    public async loadHars(): Promise<void> {
        this.harDataMap.clear();
        this.loadedHarFiles = await this._resolveHarFilePaths();
        if (this.loadedHarFiles.length === 0) {
            console.warn(chalk.yellow('[WARN] No .har files found in the specified paths. Server is running without mock data.'));
        }
        for (const filePath of this.loadedHarFiles) {
            await this._processSingleHarFile(filePath);
        }
        this.lastReloadTimestamp = new Date();
        this.printSummary();
    }

    private printSummary() {
        console.log(chalk.bold("\n--- HAR Load Summary ---"));
        let totalEntries = 0;
        for (const pathMap of this.harDataMap.values()) {
            for (const state of pathMap.values()) {
                totalEntries += state.entries.length;
            }
        }
        console.log(`[INFO] Total ${chalk.green(totalEntries)} entries loaded from ${chalk.green(this.loadedHarFiles.length)} file(s).`);
        console.log(`[INFO] Last reload at: ${this.lastReloadTimestamp?.toLocaleString()}`);
        console.log(chalk.bold("------------------------\n"));
    }

    private async _reloadAllHars() {
        console.log(chalk.blue('\n[RELOAD] Reloading all HAR files due to a change...'));
        await this.loadHars();
    }
    
    private _resetAllReplayCycles() {
        console.log(chalk.blue('[RESET] Resetting all replay cycles to index 0.'));
        let resetCount = 0;
        for (const pathMap of this.harDataMap.values()) {
            for (const state of pathMap.values()) {
                if (state.currentIndex !== 0) {
                    state.currentIndex = 0;
                    resetCount++;
                }
            }
        }
        console.log(chalk.green(`[RESET] Completed. ${resetCount} endpoint cycles were reset.`));
    }
    
    private requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const method = req.method?.toUpperCase() || 'GET';

        if (url.pathname.startsWith('/_manage')) {
            if (method === 'GET' && url.pathname === '/_manage') {
                return this._serveManagementUi(res);
            }
            if (method === 'GET' && url.pathname === '/_manage/request-details') {
                return this._serveRequestDetails(req, res);
            }
            if (method === 'POST') {
                switch (url.pathname) {
                    case '/_manage/upload': return this._handleUpload(req, res);
                    case '/_manage/delete': return this._handleDelete(req, res);
                    case '/_manage/reload':
                        await this._reloadAllHars();
                        res.writeHead(302, { 'Location': '/_manage?status=reloaded' }).end();
                        return;
                    case '/_manage/reset':
                        this._resetAllReplayCycles();
                        res.writeHead(302, { 'Location': '/_manage?status=reset' }).end();
                        return;
                }
            }
        }
        
        return this._replayRequest(req, res);
    }
    
    private _getManagementPageViewModel() {
        const files = this.loadedHarFiles.map(file => {
            const basename = path.basename(file);
            const isDeletable = path.dirname(file) === this.storageDir;
            return { basename, fullPath: file, isDeletable };
        }).sort((a, b) => a.basename.localeCompare(b.basename));

        const endpoints: {method: string, path: string, count: number, currentIndex: number}[] = [];
        for (const [method, pathMap] of this.harDataMap.entries()) {
            for (const [urlPath, state] of pathMap.entries()) {
                endpoints.push({ method, path: urlPath, count: state.entries.length, currentIndex: state.currentIndex });
            }
        }
        endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
        
        const lastReload = this.lastReloadTimestamp ? this.lastReloadTimestamp.toLocaleString() : 'N/A';
        
        return { files, endpoints, lastReload };
    }

    private _serveManagementUi(res: ServerResponse) {
        const { files, endpoints, lastReload } = this._getManagementPageViewModel();

        const renderFileList = (fileList: typeof files): string => {
            if (fileList.length === 0) return `<li class="empty-state">No HAR files loaded.</li>`;
            return fileList.map(file => `
                <li title="Full Path: ${file.fullPath}">
                    <span class="file-name">${file.basename}</span>
                    ${file.isDeletable
                        ? `<form action="/_manage/delete" method="post" style="display:inline;">
                               <input type="hidden" name="filename" value="${file.basename}" />
                               <button type="submit" class="delete" title="Delete this file">🗑️</button>
                           </form>`
                        : `<span class="readonly" title="This file is from a read-only source.">(Read-only)</span>`
                    }
                </li>
            `).join('');
        };
        
        const renderEndpointList = (endpointList: typeof endpoints): string => {
            if (endpointList.length === 0) return `<li class="empty-state">No endpoints loaded.</li>`;
            return endpointList.map(ep => `
                <li class="endpoint-item" data-search-term="${ep.method.toLowerCase()} ${ep.path.toLowerCase()}">
                    <span class="method-badge method-${ep.method.toLowerCase()}">${ep.method}</span>
                    ${ep.method === 'GET'
                        ? `<a href="${ep.path}" target="_blank" class="endpoint-path" title="${ep.path}">${ep.path}</a>`
                        : `<span class="endpoint-path" title="${ep.path}">${ep.path}</span>`
                    }
                    <span class="count-badge" title="This endpoint has ${ep.count} possible responses. Currently serving index ${ep.currentIndex}.">
                        ${ep.currentIndex + 1} / ${ep.count}
                    </span>
                    <button class="view-details-btn" data-method="${ep.method}" data-path="${ep.path}" title="View request details">Details</button>
                </li>
            `).join('');
        };

        const pageHtml = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>HAR Replay Server</title>
<style>
    :root { 
        --bg-color: #f8f9fa; --panel-bg: #ffffff; --text-color: #212529; --border-color: #dee2e6; 
        --primary: #007bff; --danger: #dc3545; --success: #28a745; --warning: #ffc107; --light-gray: #6c757d;
        --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        --font-mono: "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    html, body { height: 100%; margin: 0; overflow: auto; font-family: var(--font-sans); background-color: var(--bg-color); color: var(--text-color); }
    body { box-sizing: border-box; padding-bottom: 3em;}
    .container {
        max-width: 1400px;
        height: 100%;
        margin: 0 auto;
        padding: 2rem;
        box-sizing: border-box;
        display: grid;
        grid-template-rows: auto 1fr;
        grid-template-columns: 400px 1fr;
        gap: 2rem;
    }
    h1 { grid-column: 1 / -1; margin: 0 0 0.5rem 0; color: #343a40; }
    .sidebar { grid-row: 2 / 3; grid-column: 1 / 2; display: flex; flex-direction: column; gap: 2rem; min-height: 0; }
    .main-content { grid-row: 2 / 3; grid-column: 2 / 3; min-height: 0; }
    .panel { background: var(--panel-bg); padding: 1.5rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); display: flex; flex-direction: column; }
    h2 { border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem; margin-top: 0; margin-bottom: 1rem; font-size: 1.25rem; }
    ul { list-style: none; padding: 0; margin: 0; }
    .file-list { overflow-y: auto; }
    .file-list li, .endpoint-item {
        display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem; 
        border: 1px solid #e9ecef; border-radius: 5px; margin-bottom: 0.5rem; background-color: #fdfdfd;
    }
    .file-list li:hover { background-color: #f1f3f5; }
    /* --- FIX: Long text handling for file names --- */
    .file-name {
        font-family: var(--font-mono); font-size: 0.9em; flex-grow: 1;
        min-width: 0; /* Important for flexbox shrinking */
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .readonly { color: var(--light-gray); font-style: italic; font-size: 0.85em; }
    .empty-state { text-align: center; color: var(--light-gray); padding: 2rem; font-style: italic; }
    .upload-form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    input[type="file"] { flex-grow: 1; border: 1px solid var(--border-color); border-radius: 4px; }
    input[type="file"]::file-selector-button { background-color: #e9ecef; border: none; padding: 0.5rem 0.75rem; border-right: 1px solid var(--border-color); cursor: pointer; }
    button, .btn {
        border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; transition: filter 0.2s; font-weight: 500;
        display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;
    }
    button:hover, .btn:hover { filter: brightness(0.9); }
    .btn-primary { background-color: var(--primary); color: white; }
    .btn-success { background-color: var(--success); color: white; }
    .btn-warning { background-color: var(--warning); color: #212529; }
    button.delete { background-color: transparent; color: var(--danger); font-size: 1.2rem; padding: 0.25rem; }
    .server-actions form { display: block; margin-bottom: 0.75rem; }
    .server-actions .btn { width: 100%; }
    .status-bar { font-size: 0.85em; color: var(--light-gray); margin-top: auto; padding-top: 1rem; text-align: center; }
    #endpoint-search { width: 100%; padding: 0.5rem 0.75rem; border: 1px solid var(--border-color); border-radius: 5px; margin-bottom: 1rem; font-size: 1em; box-sizing: border-box; }
    .endpoint-list-container { height: 100%; }
    .endpoint-list { flex-grow: 1; overflow-y: auto; padding-right: 10px; }
    .endpoint-item { gap: 1rem; }
    /* --- FIX: Long text handling for URL paths --- */
    .endpoint-path {
        flex-grow: 1; font-family: var(--font-mono); color: #343a40;
        min-width: 0; /* Important for flexbox shrinking */
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    a.endpoint-path { color: var(--primary); text-decoration: none; }
    a.endpoint-path:hover { text-decoration: underline; }
    .method-badge { font-weight: bold; color: white; padding: 0.2em 0.6em; border-radius: 4px; font-size: 0.8em; text-align: center; min-width: 60px; flex-shrink: 0; }
    .method-get { background-color: #007bff; } .method-post { background-color: #28a745; } .method-put { background-color: #ffc107; }
    .method-delete { background-color: #dc3545; } .method-patch { background-color: #17a2b8; } .method-options, .method-head { background-color: #6f42c1; }
    .count-badge { background-color: #e9ecef; color: var(--light-gray); padding: 0.2em 0.6em; border-radius: 10px; font-size: 0.8em; font-family: var(--font-mono); }
    .view-details-btn {
        background-color: var(--primary);
        color: white;
        border: none;
        padding: 0.3em 0.6em;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.8em;
        transition: filter 0.2s;
        flex-shrink: 0;
    }
    .view-details-btn:hover {
        filter: brightness(0.9);
    }
</style>
</head>
<body>
<div class="container">
    <h1>HAR Replay Server</h1>
    <div class="sidebar">
        <div class="panel">
            <h2>File Management</h2>
            <form action="/_manage/upload" method="post" enctype="multipart/form-data" class="upload-form">
                <input type="file" name="harfile" accept=".har,.saz" required />
                <button type="submit" class="btn btn-primary">Upload</button>
            </form>
            <ul class="file-list">${renderFileList(files)}</ul>
        </div>
        <div class="panel">
            <h2>Server Actions</h2>
            <div class="server-actions">
                <form action="/_manage/reload" method="post">
                    <button type="submit" class="btn btn-success">🔄 Reload All HARs</button>
                </form>
                <form action="/_manage/reset" method="post">
                    <button type="submit" class="btn btn-warning">⏪ Reset All Cycles</button>
                </form>
            </div>
            <p class="status-bar">Last reload: ${lastReload}</p>
        </div>
    </div>
    <div class="main-content panel endpoint-list-container">
        <h2>Loaded Endpoints (${endpoints.length})</h2>
        <input type="text" id="endpoint-search" placeholder="Search by method or path (e.g., 'get /api/users')...">
        <ul class="endpoint-list">${renderEndpointList(endpoints)}</ul>
    </div>
</div>
<script>
    document.addEventListener('DOMContentLoaded', () => {
        const searchInput = document.getElementById('endpoint-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const searchTerm = e.target.value.toLowerCase().trim();
                const endpoints = document.querySelectorAll('.endpoint-item');
                endpoints.forEach(item => {
                    const itemTerm = item.getAttribute('data-search-term') || '';
                    if (itemTerm.includes(searchTerm)) {
                        item.style.display = 'flex';
                    } else {
                        item.style.display = 'none';
                    }
                });
            });
        }
        
        // 添加详情按钮点击事件
        document.addEventListener('click', (e) => {
            const target = e.target;// as HTMLElement;
            if (target.classList.contains('view-details-btn')) {
                const method = target.getAttribute('data-method');
                const path = target.getAttribute('data-path');
                if (method && path) {
                    window.open('/_manage/request-details?method=' + encodeURIComponent(method) + '&path=' + encodeURIComponent(path), '_blank');
                }
            }
        });
    });
</script>
</body>
</html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pageHtml);
    }
    
    private async _handleUpload(req: IncomingMessage, res: ServerResponse) {
        const form = formidable({ uploadDir: this.storageDir, keepExtensions: true });
        form.parse(req, async (err, fields, files) => {
            if (err) {
                console.error('[ERROR] Failed to parse upload:', err);
                res.writeHead(500).end('Upload failed.');
                return;
            }
            const uploadedFile = Array.isArray(files.harfile) ? files.harfile[0] : files.harfile;
            if (!uploadedFile || uploadedFile.size === 0) {
                console.warn('[WARN] Upload attempt with no file or empty file.');
                if (uploadedFile?.filepath) {
                    await fs.unlink(uploadedFile.filepath).catch(() => {});
                }
                res.writeHead(400).end('No file or empty file uploaded.');
                return;
            }
            try {
                const originalName = uploadedFile.originalFilename || 'unknown.har';
                const fileExt = path.extname(originalName).toLowerCase();
                
                // 处理 SAZ 文件
                if (fileExt === '.saz') {
                    const baseName = originalName.replace(/\\.saz$/i, '');
                    const sanitizedName = baseName.replace(/[\\\\/:\"*?<>|]/g, '_');
                    const timestamp = this._getFormattedTimestamp();
                    const randomChars = crypto.randomBytes(3).toString('hex');
                    const sazName = `${timestamp}_${sanitizedName}_${randomChars}.saz`;
                    const sazPath = path.join(this.storageDir, sazName);
                    
                    // 保存原始 SAZ 文件
                    await fs.rename(uploadedFile.filepath, sazPath);
                    console.log(chalk.green(`[UPLOAD] Saved new SAZ file as: ${sazName}`));
                    
                    // 转换为 HAR 文件
                    const harName = `${timestamp}_${sanitizedName}_${randomChars}.har`;
                    const harPath = path.join(this.storageDir, harName);
                    
                    try {
                        // 使用自定义转换器转换文件
                        await convertSazToHar(sazPath, harPath);
                        console.log(chalk.green(`[CONVERT] Converted SAZ to HAR: ${harName}`));
                        
                        // 删除原始 SAZ 文件（可选）
                        await fs.unlink(sazPath).catch(() => {});
                        
                        // 重新加载 HAR 文件
                        await this._reloadAllHars();
                    } catch (utf8Error) {
                        console.warn('[WARN] UTF-8 conversion failed, trying GBK encoding:', (utf8Error as Error).message);
                        try {
                            // 转换文件
                            await convertSazToHar(sazPath, harPath);
                            console.log(chalk.green(`[CONVERT] Converted SAZ to HAR with GBK encoding: ${harName}`));
                            
                            // 删除原始 SAZ 文件（可选）
                            await fs.unlink(sazPath).catch(() => {});
                            
                            // 重新加载 HAR 文件
                            await this._reloadAllHars();
                        } catch (gbkError) {
                            console.error('[ERROR] Both UTF-8 and GBK conversion failed:', gbkError);
                            // 如果转换失败，删除上传的 SAZ 文件
                            await fs.unlink(sazPath).catch(() => {});
                            throw gbkError;
                        }
                    }
                } 
                // 处理 HAR 文件
                else if (fileExt === '.har') {
                    const baseName = originalName.replace(/\\.har$/i, '');
                    const sanitizedName = baseName.replace(/[\\\\/:\"*?<>|]/g, '_');
                    const timestamp = this._getFormattedTimestamp();
                    const randomChars = crypto.randomBytes(3).toString('hex');
                    const newName = `${timestamp}_${sanitizedName}_${randomChars}.har`;
                    const newPath = path.join(this.storageDir, newName);
                    await fs.rename(uploadedFile.filepath, newPath);
                    console.log(chalk.green(`[UPLOAD] Saved new file as: ${newName}`));
                    await this._reloadAllHars();
                } 
                // 不支持的文件类型
                else {
                    console.warn(`[WARN] Upload attempt with unsupported file type: ${fileExt}`);
                    if (uploadedFile.filepath) {
                        await fs.unlink(uploadedFile.filepath).catch(() => {});
                    }
                    res.writeHead(400).end('Unsupported file type. Only .har and .saz files are allowed.');
                    return;
                }
            } catch (processError) {
                console.error('[ERROR] Failed to process uploaded file:', processError);
                if (uploadedFile?.filepath) {
                    await fs.unlink(uploadedFile.filepath).catch(() => {});
                }
                res.writeHead(500).end('Failed to process uploaded file.');
                return;
            } finally {
                res.writeHead(302, { 'Location': '/_manage' });
                res.end();
            }
        });
    }

    private async _handleDelete(req: IncomingMessage, res: ServerResponse) {
        const body = await this.getRequestBody(req);
        const params = new URLSearchParams(body);
        const filename = params.get('filename');
        if (!filename) {
            res.writeHead(400).end('Filename not provided.');
            return;
        }
        const filePath = path.join(this.storageDir, filename);
        if (path.dirname(filePath) !== this.storageDir || !this.loadedHarFiles.includes(filePath)) {
            console.warn(chalk.yellow(`[SECURITY] Attempted to delete an invalid or non-managed file: ${filename}`));
            res.writeHead(403).end('Forbidden.');
            return;
        }
        try {
            await fs.unlink(filePath);
            console.log(chalk.red(`[DELETE] Deleted file: ${filename}`));
            await this._reloadAllHars();
        } catch (deleteError) {
            console.error(`[ERROR] Failed to delete file ${filename}:`, deleteError);
        } finally {
            res.writeHead(302, { 'Location': '/_manage' });
            res.end();
        }
    }
    
    private _serveRequestDetails = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const method = url.searchParams.get('method') || '';
        const path = url.searchParams.get('path') || '';
        
        const replayState = this.harDataMap.get(method)?.get(path);
        if (!replayState || replayState.entries.length === 0) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2>No request data found</h2>');
            return;
        }

        // 获取所有匹配的请求详情
        const requests = replayState.entries.map((entry, index) => {
            return {
                index,
                request: entry.request,
                responseStatus: entry.response.status
            };
        });

        const detailsHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Request Details - ${method} ${path}</title>
    <style>
        :root { 
            --bg-color: #f8f9fa; --panel-bg: #ffffff; --text-color: #212529; --border-color: #dee2e6; 
            --primary: #007bff; --danger: #dc3545; --success: #28a745; --warning: #ffc107; --light-gray: #6c757d;
            --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            --font-mono: "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        }
        body { 
            font-family: var(--font-sans); 
            background-color: var(--bg-color); 
            color: var(--text-color); 
            margin: 0; 
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 { 
            color: #343a40; 
            margin-bottom: 1rem;
            font-size: 1.5rem;
        }
        .back-link {
            display: inline-block;
            margin-bottom: 1rem;
            color: var(--primary);
            text-decoration: none;
        }
        .back-link:hover {
            text-decoration: underline;
        }
        .request-list {
        }
        .request-card {
            background: var(--panel-bg);
            border-radius: 8px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.05);
            padding: 20px;
            min-width: 300px;
            margin-bottom: 5px;
        }
        .request-card h2 {
            margin-top: 0;
            font-size: 1.2rem;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 10px;
        }
        .request-card h3 {
            font-size: 1rem;
            margin: 15px 0 10px;
        }
        .request-info {
            margin-bottom: 15px;
        }
        .request-info div {
            margin-bottom: 5px;
        }
        .header-list, .param-list {
            background: #f8f9fa;
            border-radius: 4px;
            padding: 10px;
            font-family: var(--font-mono);
            font-size: 0.9em;
            max-height: 200px;
            overflow-y: auto;
        }
        .header-item, .param-item {
            margin-bottom: 5px;
        }
        .header-name, .param-name {
            font-weight: bold;
            color: #495057;
        }
        .post-data {
            background: #f8f9fa;
            border-radius: 4px;
            padding: 10px;
            font-family: var(--font-mono);
            font-size: 0.9em;
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 200px;
            overflow-y: auto;
        }
        .empty {
            color: var(--light-gray);
            font-style: italic;
        }
        .simulate-btn {
            background-color: var(--success);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9em;
            margin-top: 15px;
            transition: filter 0.2s;
        }
        .simulate-btn:hover {
            filter: brightness(0.9);
        }
        .simulate-btn:disabled {
            background-color: #6c757d;
            cursor: not-allowed;
        }
        .response-container {
            margin-top: 15px;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 4px;
            display: none;
        }
        .response-header {
            font-weight: bold;
            margin-bottom: 5px;
        }
        .response-content {
            font-family: var(--font-mono);
            font-size: 0.9em;
            white-space: pre-wrap;
            word-break: break-all;
            max-height: 300px;
            overflow-y: auto;
        }
    </style>
</head>
<body>
    <div class="container">
        <a href="/_manage" class="back-link">← Back to Management</a>
        <h1>Request Details: ${method} ${path}</h1>
        
        <div class="request-list">
            ${requests.map(req => `
                <div class="request-card">
                    <h2>Request #${req.index + 1} (Response Status: ${req.responseStatus})</h2>
                    
                    <div class="request-info">
                        <div><strong>Method:</strong> ${req.request.method}</div>
                        <div><strong>URL:</strong> ${req.request.url}</div>
                    </div>
                    
                    <h3>Headers (${req.request.headers.length})</h3>
                    ${req.request.headers.length > 0 ? `
                        <div class="header-list">
                            ${req.request.headers.map(header => `
                                <div class="header-item">
                                    <span class="header-name">${header.name}:</span> 
                                    <span class="header-value">${header.value}</span>
                                </div>
                            `).join('')}
                        </div>
                    ` : '<div class="empty">No headers</div>'}
                    
                    ${req.request.postData ? `
                        <h3>Post Data</h3>
                        <div><strong>MIME Type:</strong> ${req.request.postData.mimeType}</div>
                        ${req.request.postData.params ? `
                            <h3>Parameters (${req.request.postData.params.length})</h3>
                            ${req.request.postData.params.length > 0 ? `
                                <div class="param-list">
                                    ${req.request.postData.params.map(param => `
                                        <div class="param-item">
                                            <span class="param-name">${param.name}:</span> 
                                            <span class="param-value">${param.value}</span>
                                        </div>
                                    `).join('')}
                                </div>
                            ` : '<div class="empty">No parameters</div>'}
                        ` : ''}
                        ${req.request.postData.text ? `
                            <h3>Body Content</h3>
                            <div class="post-data">${req.request.postData.text}</div>
                        ` : ''}
                    ` : ''}
                    
                    <button class="simulate-btn" data-request-index="${req.index}" data-method="${req.request.method}" data-url="${req.request.url}">模拟请求</button>
                    <div class="response-container" id="response-${req.index}">
                        <div class="response-header">Response:</div>
                        <div class="response-content" id="response-content-${req.index}"></div>
                    </div>
                </div>
            `).join('')}
        </div>
    </div>
    
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            // 添加模拟请求功能
            document.addEventListener('click', async (e) => {
                if (e.target.classList.contains('simulate-btn')) {
                    const btn = e.target;
                    const requestIndex = btn.getAttribute('data-request-index');
                    const responseContainer = document.getElementById('response-' + requestIndex);
                    const responseContent = document.getElementById('response-content-' + requestIndex);
                    
                    // 禁用按钮并显示加载状态
                    btn.disabled = true;
                    btn.textContent = '请求中...';
                    responseContainer.style.display = 'block';
                    responseContent.textContent = '发送请求中...';
                    
                    try {
                        // 替换URL中的host为当前host
                        const currentHost = window.location.host;
                        // 构造请求选项
                        const requestOptions = {
                            method: '${method}',
                            headers: {}
                        };
                        
                        // 发送请求
                        const response = await fetch('${path}', requestOptions);
                        
                        // 显示响应
                        const statusText = response.statusText || 'Unknown';
                        let responseText = 'Status: ' + response.status + ' ' + statusText + '\\n';
                        
                        // 添加响应头
                        responseText += '\\nHeaders:\\n';
                        for (const [key, value] of response.headers.entries()) {
                            responseText += \`\${key}: \${value}\n\`;
                        }
                        
                        // 添加响应体
                        responseText += '\\nBody:\\n';
                        try {
                            const body = await response.text();
                            responseText += body;
                        } catch (err) {
                            responseText += '无法读取响应体: ' + err.message;
                        }
                        
                        responseContent.textContent = responseText;
                    } catch (error) {
                        console.error('请求失败: ',error)
                        responseContent.textContent = '请求失败: ' + error.message;
                    } finally {
                        // 恢复按钮状态
                        btn.disabled = false;
                        btn.textContent = '模拟请求';
                    }
                }
            });
        });
    </script>
</body>
</html>`;
        
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(detailsHtml);
    }

    private _replayRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            const method = req.method?.toUpperCase() || 'GET';
            const requestUrl = req.url || '/';
            const urlPath = new URL(requestUrl, `http://${req.headers.host}`).pathname;
            console.log(`[REQUEST] Received: ${method} ${this.colorizeUrlPath(method, urlPath)}`);
            const replayState = this.harDataMap.get(method)?.get(urlPath);
            if (!replayState || replayState.entries.length === 0) {
                console.warn(`[NO MATCH] No candidate found for path: ${method} ${urlPath}`);
                if (!res.headersSent) res.writeHead(404);
                if (!res.writableEnded) res.end(`No entry found for path: ${method} ${urlPath}`);
                return;
            }
            let priorityMatch: HarEntry | null = null;
            if (this.METHODS_WITH_BODY.has(method)) {
                const reqBody = await this.getRequestBody(req);
                for (const entry of replayState.entries) if (this.compareBody(reqBody, entry.request.postData)) { priorityMatch = entry; break; }
            } else {
                for (const entry of replayState.entries) if (this.compareQueryParams(requestUrl, entry.request.url)) { priorityMatch = entry; break; }
            }
            if (priorityMatch) {
                console.log(chalk.green(`[MATCH] Found a priority match.`));
                this.sendResponse(res, priorityMatch);
                return;
            }
            const { entries, currentIndex } = replayState;
            const fallbackEntry = entries[currentIndex];
            console.log(`[MATCH] No priority match. Using fallback cycle: serving response ${chalk.yellow(currentIndex + 1)} of ${entries.length}`);
            replayState.currentIndex = (currentIndex + 1) % entries.length;
            this.sendResponse(res, fallbackEntry);
        } catch (error) {
            console.error(chalk.red('[FATAL REPLAY ERROR]'), error);
            if (!res.headersSent) res.writeHead(500);
            if (!res.writableEnded) res.end('Internal Server Error');
        }
    }

    private sendResponse(res: ServerResponse, entry: HarEntry | null | undefined): void {
        if (!entry?.response) {
            if (!res.headersSent) res.writeHead(500);
            if (!res.writableEnded) res.end('Internal Server Error: Malformed HAR entry data.');
            return;
        }
        const { response } = entry;
        const headers: http.OutgoingHttpHeaders = {};
        response.headers
            .filter(h => !['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(h.name.toLowerCase()))
            .forEach(h => { headers[h.name] = h.value; });
        res.writeHead(response.status, response.statusText, headers);
        if (response.content?.text) {
            const body = response.content.encoding === 'base64' ? Buffer.from(response.content.text, 'base64') : response.content.text;
            res.end(body);
        } else {
            res.end();
        }
    }
    
    public async start(): Promise<void> {
        await fs.mkdir(this.storageDir, { recursive: true });
        await this.loadHars();
        
        const server = http.createServer(this.requestHandler); 
        server.listen(this.port, () => {
            console.log(`🚀 HAR Replay Server is running on http://localhost:${this.port}`);
            console.log(`✅ Management UI is available at http://localhost:${this.port}/_manage`);
            console.log(`   HAR files will be saved to: ${this.storageDir}`);
        }).on('error', (err) => {
            console.error('[FATAL] Failed to start server:', err);
        });
    }
}

// 解析命令行参数 --port=xxxx 和 --path=xxxx
function getArgvValue(key: string): string | undefined {
  const arg = process.argv.find(arg => arg.startsWith(`--${key}=`));
  if (arg) return arg.split('=')[1];
  return undefined;
}

function getPortFromArgv(defaultPort: number): number {
  const portStr = getArgvValue('port');
  if (portStr) {
    const port = parseInt(portStr, 10);
    if (!isNaN(port)) return port;
  }
  return defaultPort;
}

function getStoragePath(defaultPath: string): string {
  return getArgvValue('path') || process.env.STORAGE_PATH || defaultPath;
}

const port = getPortFromArgv(
  process.env.PORT ? parseInt(process.env.PORT, 10) : 3000
);
const storageDir = getStoragePath('./har_storage');

// --- 主程序入口 ---
const sources = process.argv.slice(2).filter(arg => !arg.startsWith('--port=') && !arg.startsWith('--path='));
if (sources.length === 0) {
    console.log('Usage: ts-node src/server.ts [path-to-har-file | path-to-directory] ... [--port=PORT] [--path=STORAGE_DIR]');
    console.log('No initial paths provided. Server will start with an empty set, manage files via UI.');
}
const server = new HarReplayServer(sources, storageDir, port);
server.start();
