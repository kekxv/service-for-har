import http, { IncomingMessage, ServerResponse } from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { URL, URLSearchParams } from 'url';
import { deepEqual } from 'assert';
import chalk from 'chalk';
import formidable from 'formidable';
import crypto from 'crypto';

// --- 类型定义 ---
interface HarHeader { name: string; value: string; }
interface HarPostData { mimeType: string; text?: string; }
interface HarContent { text?: string; encoding?: 'base64' | string; mimeType: string; }
interface HarResponse { status: number; statusText: string; headers: HarHeader[]; content: HarContent; }
interface HarRequest { method: string; url:string; postData?: HarPostData; }
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
        console.log(chalk.bold("------------------------\n"));
    }

    private async _reloadAllHars() {
        console.log(chalk.blue('\n[RELOAD] Reloading all HAR files due to a change...'));
        await this.loadHars();
    }
    
    private requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const method = req.method?.toUpperCase() || 'GET';
        if (url.pathname === '/_manage' && method === 'GET') {
            return this._serveManagementUi(res);
        }
        if (url.pathname === '/_manage/upload' && method === 'POST') {
            return this._handleUpload(req, res);
        }
        if (url.pathname === '/_manage/delete' && method === 'POST') {
            return this._handleDelete(req, res);
        }
        return this._replayRequest(req, res);
    }
    
    private _serveManagementUi(res: ServerResponse) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

        const filesHtml = this.loadedHarFiles.length > 0 
            ? this.loadedHarFiles.map(file => {
                const basename = path.basename(file);
                const isDeletable = path.dirname(file) === this.storageDir;
                const deleteButton = isDeletable 
                    ? `<form action="/_manage/delete" method="post" style="display:inline;">
                           <input type="hidden" name="filename" value="${basename}" />
                           <button type="submit" class="delete">Delete</button>
                       </form>`
                    : `<span class="readonly">(Read-only)</span>`;
                return `<li><span>${basename}</span> ${deleteButton}</li>`;
            }).join('')
            : '<li class="empty-state">No HAR files loaded.</li>';
            
        let endpointsHtml = '';
        if (this.harDataMap.size > 0) {
            const allEndpoints: {method: string, path: string, count: number}[] = [];
            for (const [method, pathMap] of this.harDataMap.entries()) {
                for (const [urlPath, state] of pathMap.entries()) {
                    allEndpoints.push({ method, path: urlPath, count: state.entries.length });
                }
            }

            allEndpoints.sort((a, b) => {
                const aIsHtml = a.path.endsWith('.html') || a.path.endsWith('.htm');
                const bIsHtml = b.path.endsWith('.html') || b.path.endsWith('.htm');
                if (aIsHtml && !bIsHtml) return -1;
                if (!aIsHtml && bIsHtml) return 1;
                if (a.path < b.path) return -1;
                if (a.path > b.path) return 1;
                if (a.method < b.method) return -1;
                if (a.method > b.method) return 1;
                return 0;
            });
            
            endpointsHtml = allEndpoints.map(endpoint => {
                const pathElement = endpoint.method === 'GET'
                    ? `<a href="${endpoint.path}" target="_blank" class="endpoint-path">${endpoint.path}</a>`
                    : `<span class="endpoint-path">${endpoint.path}</span>`;
                
                return `
                    <li class="endpoint-item">
                        <span class="method-badge method-${endpoint.method.toLowerCase()}">${endpoint.method}</span>
                        ${pathElement}
                        <span class="count-badge">${endpoint.count}</span>
                    </li>`;
            }).join('');

        } else {
            endpointsHtml = '<li class="empty-state">No endpoints loaded.</li>';
        }

        const pageHtml = `
            <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>HAR Replay Server Management</title>
            <style>
                :root { --main-bg: #f4f4f9; --panel-bg: #ffffff; --text-color: #333; --border-color: #ddd; --primary-color: #007bff; --danger-color: #dc3545; --light-gray: #888; }
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: var(--main-bg); color: var(--text-color); margin: 0; padding: 2em; }
                .container { max-width: 1200px; margin: auto; }
                h1 { color: #444; margin-bottom: 1em; }
                .grid-container { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 2em; }
                .panel { background: var(--panel-bg); padding: 1.5em; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
                h2 { color: #444; border-bottom: 2px solid #eee; padding-bottom: 10px; margin-top: 0; }
                .upload-form { margin-bottom: 2em; display: flex; gap: 10px; align-items: center; }
                input[type="file"] { border: 1px solid var(--border-color); padding: 10px; border-radius: 4px; flex-grow: 1; }
                button { background-color: var(--primary-color); color: white; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; }
                button:hover { background-color: #0056b3; }
                button.delete { background-color: var(--danger-color); }
                button.delete:hover { background-color: #c82333; }
                ul { list-style: none; padding: 0; }
                li { background: #fafafa; border: 1px solid #eee; padding: 10px 15px; margin-bottom: 8px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; font-size: 0.95em; }
                li > span:first-child { font-family: 'Menlo', 'Courier New', monospace; flex-grow: 1; word-break: break-all; }
                .endpoint-list li > span:first-child {flex-grow: unset;}
                .readonly, .empty-state { color: var(--light-gray); font-style: italic; }
                .endpoint-list { max-height: 60vh; overflow-y: auto; padding-right: 10px; }
                .endpoint-item { gap: 15px; }
                .endpoint-path { flex-grow: 1; font-family: 'Menlo', 'Courier New', monospace; color: #555; word-break: break-all; }
                a.endpoint-path { color: var(--primary-color); text-decoration: none; }
                a.endpoint-path:hover { text-decoration: underline; }
                .method-badge { font-weight: bold; color: white; padding: 3px 8px; border-radius: 4px; font-size: 0.8em; text-align: center; min-width: 60px; flex-shrink: 0; }
                .method-get { background-color: #61affe; }
                .method-post { background-color: #49cc90; }
                .method-put { background-color: #fca130; }
                .method-delete { background-color: #f93e3e; }
                .method-patch { background-color: #50e3c2; }
                .method-options, .method-head { background-color: #9013fe; }
                .count-badge { background-color: #e0e0e0; color: #555; padding: 3px 8px; border-radius: 10px; font-size: 0.8em; }
            </style>
            </head><body><div class="container">
                <h1>HAR Replay Server</h1>
                <div class="grid-container">
                    <div class="panel">
                        <h2>File Management</h2>
                        <div class="upload-form">
                            <form action="/_manage/upload" method="post" enctype="multipart/form-data" style="display: flex; flex-grow: 1; gap: 10px;">
                                <input type="file" name="harfile" accept=".har" required />
                                <button type="submit">Upload</button>
                            </form>
                        </div>
                        <ul class="file-list">${filesHtml}</ul>
                    </div>
                    <div class="panel">
                        <h2>Loaded Endpoints</h2>
                        <ul class="endpoint-list">${endpointsHtml}</ul>
                    </div>
                </div>
            </div></body></html>`;
        res.end(pageHtml);
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
                const baseName = originalName.replace(/\.har$/i, '');
                const sanitizedName = baseName.replace(/[\\/:"*?<>|]/g, '_');
                const timestamp = this._getFormattedTimestamp();
                const randomChars = crypto.randomBytes(3).toString('hex');
                const newName = `${timestamp}_${sanitizedName}_${randomChars}.har`;
                const newPath = path.join(this.storageDir, newName);
                await fs.rename(uploadedFile.filepath, newPath);
                console.log(chalk.green(`[UPLOAD] Saved new file as: ${newName}`));
                await this._reloadAllHars();
            } catch (processError) {
                console.error('[ERROR] Failed to process uploaded file:', processError);
                if (uploadedFile.filepath) {
                    await fs.unlink(uploadedFile.filepath).catch(() => {});
                }
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
    
    private _replayRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            const method = req.method?.toUpperCase() || 'GET';
            const requestUrl = req.url || '/';
            const urlPath = new URL(requestUrl, `http://${req.headers.host}`).pathname;
            console.log(`[REQUEST] Received: ${method} ${requestUrl} (Matching path: ${urlPath})`);
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

// --- 主程序入口 ---
const sources = process.argv.slice(2);
if (sources.length === 0) {
    console.log('Usage: ts-node src/server.ts [path-to-har-file | path-to-directory] ...');
    console.log('No initial paths provided. Server will start with an empty set, manage files via UI.');
}
const server = new HarReplayServer(sources, './har_storage', 3000);
server.start();
