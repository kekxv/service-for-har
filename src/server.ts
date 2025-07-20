import http, { IncomingMessage, ServerResponse } from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { URL, URLSearchParams } from 'url';
import { deepEqual } from 'assert';
import chalk from 'chalk';

// --- 类型定义 (无变化) ---
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
    private harFilePath: string;
    private harDataMap: Map<string, Map<string, ReplayState>> = new Map();
    private readonly METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

    constructor(harFilePath: string, port: number = 3000) {
        this.port = port;
        this.harFilePath = path.resolve(harFilePath);
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
    
    private async loadAndProcessHar(): Promise<void> {
        console.log(`[INFO] Loading HAR file from: ${this.harFilePath}`);
        try {
            const fileContent = await fs.readFile(this.harFilePath, 'utf-8');
            const harJson: HarFile = JSON.parse(fileContent);

            for (const entry of harJson.log.entries) {
                if (!entry || !entry.request || !entry.request.url || !entry.response) {
                    console.warn(chalk.yellow('[WARN] Skipping malformed or incomplete entry in HAR file.'));
                    continue;
                }

                const method = entry.request.method.toUpperCase();
                const urlObject = new URL(entry.request.url, 'http://dummy.base');
                const urlPath = urlObject.pathname;

                const pathMap = this.harDataMap.get(method) || new Map<string, ReplayState>();
                if (!this.harDataMap.has(method)) this.harDataMap.set(method, pathMap);

                const state = pathMap.get(urlPath) || { entries: [], currentIndex: 0 };
                if (!pathMap.has(urlPath)) pathMap.set(urlPath, state);

                state.entries.push(entry);
            }
            
            console.log(chalk.bold("\n--- HAR Load Summary ---"));
            for (const [method, pathMap] of this.harDataMap.entries()) {
                for (const [path, state] of pathMap.entries()) {
                    const coloredPath = this.colorizeUrlPath(method, path);
                    const count = chalk.yellow(state.entries.length);
                    console.log(`[INFO] Mapped: ${chalk.bold(method)} ${coloredPath} (${count} response(s) available)`);
                }
            }
            console.log(chalk.bold("------------------------\n"));
        } catch (error) {
            console.error(`[ERROR] Failed to load or parse HAR file: ${this.harFilePath}`, error);
            process.exit(1);
        }
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
        p1.sort();
        p2.sort();
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
    
    private sendResponse(res: ServerResponse, entry: HarEntry | null | undefined): void {
        if (!entry || !entry.response) {
            console.error('[ERROR] Attempted to send a response from a null or malformed HAR entry.');
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
            }
            if (!res.writableEnded) {
                res.end('Internal Server Error: Malformed HAR entry data.');
            }
            return;
        }

        const { response } = entry;
        const headers: http.OutgoingHttpHeaders = {};
        
        // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
        // ★★★   THE KEY FIX IS HERE   ★★★
        // ★★★   过滤掉 Content-Length，让 Node 自动计算   ★★★
        // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
        const a = response.headers
            .filter(h => !['content-encoding', 'transfer-encoding', 'connection', 'content-length'].includes(h.name.toLowerCase()))
            .forEach(h => { headers[h.name] = h.value; });
        
        res.writeHead(response.status, response.statusText, headers);

        if (response.content && response.content.text) {
            const body = response.content.encoding === 'base64' 
                ? Buffer.from(response.content.text, 'base64') 
                : response.content.text;
            res.end(body);
        } else {
            res.end();
        }
    }
    
    private requestHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            const method = req.method?.toUpperCase() || 'GET';
            const requestUrl = req.url || '/';
            const urlPath = requestUrl.split('?')[0];

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
                for (const entry of replayState.entries) {
                    if (this.compareBody(reqBody, entry.request.postData)) {
                        priorityMatch = entry;
                        break;
                    }
                }
            } else {
                for (const entry of replayState.entries) {
                    if (this.compareQueryParams(requestUrl, entry.request.url)) {
                        priorityMatch = entry;
                        break;
                    }
                }
            }
            
            if (priorityMatch) {
                console.log(chalk.green(`[MATCH] Found a priority match based on request parameters/body.`));
                this.sendResponse(res, priorityMatch);
                return;
            }

            const { entries, currentIndex } = replayState;
            const fallbackEntry = entries[currentIndex];
            
            console.log(`[MATCH] No priority match. Using fallback cycle: serving response ${chalk.yellow(currentIndex + 1)} of ${entries.length}`);
            
            replayState.currentIndex = (currentIndex + 1) % entries.length;

            this.sendResponse(res, fallbackEntry);

        } catch (error) {
            console.error(chalk.red('[FATAL HANDLER ERROR] An unexpected error occurred while handling request:'), error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
            }
            if (!res.writableEnded) {
                res.end('Internal Server Error');
            }
        }
    }
    
    public async start(): Promise<void> {
        await this.loadAndProcessHar();
        const server = http.createServer(this.requestHandler);
        server.listen(this.port, () => {
            console.log(`🚀 HAR Replay Server is running on http://localhost:${this.port}`);
            console.log(`   Simulating requests from: ${path.basename(this.harFilePath)}`);
            console.log(`   ${chalk.yellow('Matching logic:')} Priority on params/body, then fallback to cyclic replay.`);
        }).on('error', (err) => {
            console.error('[FATAL] Failed to start server:', err);
        });
    }
}

const harFile = process.argv[2];
if (!harFile) {
    console.error('Usage: ts-node src/server.ts <path-to-your-har-file.har>');
    process.exit(1);
}
const server = new HarReplayServer(harFile, 3000);
server.start();
