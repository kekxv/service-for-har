import { promises as fs } from 'fs';
import path from 'path';
import extract from 'extract-zip';
import iconv from 'iconv-lite';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { rimraf } from 'rimraf';
import { XMLParser } from 'fast-xml-parser';

// HAR 类型定义
interface HarHeader {
    name: string;
    value: string;
}

interface HarPostData {
    mimeType: string;
    text?: string;
    params?: Array<{ name: string; value: string }>;
    encoding?: 'base64' | string;
}

interface HarContent {
    text?: string;
    encoding?: 'base64' | string;
    mimeType: string;
    size?: number;
}

interface HarResponse {
    status: number;
    statusText: string;
    headers: HarHeader[];
    content: HarContent;
}

interface HarRequest {
    method: string;
    url: string;
    headers: HarHeader[];
    postData?: HarPostData;
}

interface HarEntry {
    startedDateTime: string;
    time: number;
    request: HarRequest;
    response: HarResponse;
    cache: {};
    timings: {};
}

interface HarLog {
    version: string;
    creator: { name: string; version: string };
    entries: HarEntry[];
}

interface HarFile {
    log: HarLog;
}

// SAZ 文件结构
interface SazFileData {
    position: number;
    raw: {
        request?: string;
        response?: string;
        metadata?: string;
    };
}

/**
 * 解析单个 SAZ 文件内容
 * @param filename 文件名
 * @param content 文件内容（二进制）
 * @returns 解析后的 SAZ 数据
 */
function parseSazFile(filename: string, content: Buffer): SazFileData | null {
    // SAZ 文件命名规则: 01_c.txt, 01_m.xml, 01_s.txt, 01_w.txt
    const filenameMatches = filename.match(/(\d+)_(s|c|m|w)/);
    
    if (!filenameMatches) {
        return null;
    }
    
    const position = parseInt(filenameMatches[1], 10);
    const letter = filenameMatches[2];
    
    // 直接使用 Buffer 处理内容，不进行解码，保持原始二进制数据
    // 但是需要将 Buffer 转换为 binary string 以便后续处理
    const rawContent = content.toString('binary');
    
    let type = '';
    switch (letter) {
        case 'c':
            // 客户端请求
            type = 'request';
            break;
        case 's':
            // 服务端响应
            type = 'response';
            break;
        case 'm':
            // 元数据
            type = 'metadata';
            break;
        case 'w':
            // WebSocket 消息（可选）
            type = 'websocket';
            break;
        default:
            return null;
    }
    
    return {
        position,
        raw: {
            [type]: rawContent
        }
    };
}

/**
 * 解析元数据 XML
 * @param xmlContent XML 内容
 * @returns 解析后的对象
 */
function parseMetadataXml(xmlContent: string): any {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: 'text'
    });
    
    try {
        return parser.parse(xmlContent);
    } catch (error) {
        console.error('Failed to parse metadata XML:', error);
        return {};
    }
}

/**
 * 解析 HTTP 请求
 * @param requestContent 请求内容（binary string）
 * @returns 解析后的请求对象
 */
function parseHttpRequest(requestContent: string): HarRequest | null {
    if (!requestContent) return null;
    
    // 将 binary string 转换为 Buffer 以正确处理二进制数据
    const buffer = Buffer.from(requestContent, 'binary');
    
    // 查找请求头和请求体的分隔位置
    const headerEndIndex = buffer.indexOf('\r\n\r\n');
    const headerEndIndexLF = headerEndIndex === -1 ? buffer.indexOf('\n\n') : -1;
    const actualHeaderEndIndex = headerEndIndex !== -1 ? headerEndIndex : headerEndIndexLF;
    
    let headersBuffer: Buffer;
    let bodyBuffer: Buffer;
    
    if (actualHeaderEndIndex !== -1) {
        // 分离请求头和请求体
        headersBuffer = buffer.subarray(0, actualHeaderEndIndex);
        bodyBuffer = buffer.subarray(actualHeaderEndIndex + (headerEndIndex !== -1 ? 4 : 2));
    } else {
        // 如果没有找到分隔符，则整个内容都视为请求头
        headersBuffer = buffer;
        bodyBuffer = Buffer.alloc(0);
    }
    
    // 解析请求行
    const headersString = headersBuffer.toString('utf-8');
    const lines = headersString.split(/\r\n|\n/);
    const requestLine = lines[0].trim();
    const [method, url, protocol] = requestLine.split(' ');
    
    if (!method || !url) return null;
    
    const headers: HarHeader[] = [];
    
    // 解析请求头
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') {
            break;
        }
        
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
            const name = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim();
            headers.push({ name, value });
        }
    }
    
    // 解析请求体
    let postData: HarPostData | undefined;
    if (bodyBuffer.length > 0) {
        const contentTypeHeader = headers.find(h => h.name.toLowerCase() === 'content-type');
        const mimeType = contentTypeHeader ? contentTypeHeader.value.split(';')[0].trim() : 'text/plain';
        
        // 对于表单数据，使用 params 格式
        if (mimeType === 'application/x-www-form-urlencoded') {
            const bodyString = bodyBuffer.toString('utf-8');
            const params: Array<{ name: string; value: string }> = [];
            
            for (const pair of bodyString.split('&')) {
                const [key, value] = pair.split('=');
                params.push({
                    name: decodeURIComponent(key || ''),
                    value: decodeURIComponent(value || '')
                });
            }
            
            postData = {
                mimeType,
                params
            };
        } else {
            // 对于其他类型，直接使用文本或 base64 编码
            const textMimeTypes = [
                'text/',
                'application/json',
                'application/javascript',
                'application/xml',
                'application/xhtml+xml'
            ];
            
            const isTextContent = textMimeTypes.some(type => mimeType.startsWith(type));
            
            // 检查是否包含二进制数据（控制字符）
            const isBinary = bodyBuffer.some(byte => byte <= 0x08 || (byte >= 0x0B && byte <= 0x1F) || byte === 0x7F);
            
            // 对于图片等二进制内容，或者包含控制字符的内容，使用 base64 编码
            if (mimeType.startsWith('image/') || isBinary || (!isTextContent && bodyBuffer.length > 0)) {
                postData = {
                    mimeType,
                    text: bodyBuffer.toString('base64'),
                    encoding: 'base64'
                };
            } else {
                postData = {
                    mimeType,
                    text: bodyBuffer.toString('utf-8')
                };
            }
        }
    }
    
    return {
        method,
        url,
        headers,
        postData
    };
}

/**
 * 解析 HTTP 响应
 * @param responseContent 响应内容（binary string）
 * @returns 解析后的响应对象
 */
function parseHttpResponse(responseContent: string): HarResponse | null {
    if (!responseContent) return null;
    
    // 将 binary string 转换为 Buffer 以正确处理二进制数据
    const buffer = Buffer.from(responseContent, 'binary');
    
    // 查找响应头和响应体的分隔位置
    const headerEndIndex = buffer.indexOf('\r\n\r\n');
    const headerEndIndexLF = headerEndIndex === -1 ? buffer.indexOf('\n\n') : -1;
    const actualHeaderEndIndex = headerEndIndex !== -1 ? headerEndIndex : headerEndIndexLF;
    
    let headersBuffer: Buffer;
    let bodyBuffer: Buffer;
    
    if (actualHeaderEndIndex !== -1) {
        // 分离响应头和响应体
        headersBuffer = buffer.subarray(0, actualHeaderEndIndex);
        bodyBuffer = buffer.subarray(actualHeaderEndIndex + (headerEndIndex !== -1 ? 4 : 2));
    } else {
        // 如果没有找到分隔符，则整个内容都视为响应头
        headersBuffer = buffer;
        bodyBuffer = Buffer.alloc(0);
    }
    
    // 解析响应行
    const headersString = headersBuffer.toString('utf-8');
    const lines = headersString.split(/\r\n|\n/);
    const statusLine = lines[0].trim();
    const parts = statusLine.split(' ');
    const status = parseInt(parts[1]);
    const statusText = parts.slice(2).join(' ');
    
    if (isNaN(status)) return null;
    
    const headers: HarHeader[] = [];
    let contentLength = 0;
    
    // 解析响应头
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') {
            break;
        }
        
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
            const name = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim();
            headers.push({ name, value });
            
            if (name.toLowerCase() === 'content-length') {
                contentLength = parseInt(value) || 0;
            }
        }
    }
    
    // 获取 MIME 类型
    const contentTypeHeader = headers.find(h => h.name.toLowerCase() === 'content-type');
    const mimeType = contentTypeHeader ? contentTypeHeader.value.split(';')[0].trim() : 'text/plain';
    
    const content: HarContent = {
        mimeType,
        size: contentLength || bodyBuffer.length
    };
    
    // 根据内容类型决定是否使用 base64 编码
    // 需要 base64 编码的 MIME 类型
    const binaryMimeTypes = [
        'image/',
        'application/octet-stream',
        'application/pdf',
        'application/zip',
        'application/x-zip-compressed',
        'application/vnd.openxmlformats-officedocument',
        'application/msword',
        'application/vnd.ms-excel',
        'application/vnd.ms-powerpoint'
    ];
    
    // 文本类型的 MIME 类型
    const textMimeTypes = [
        'text/',
        'application/json',
        'application/javascript',
        'application/xml',
        'application/xhtml+xml',
        'application/rss+xml',
        'application/atom+xml'
    ];
    
    // 判断是否为二进制内容
    const isBinaryContent = binaryMimeTypes.some(type => mimeType.startsWith(type));
    const isTextContent = textMimeTypes.some(type => mimeType.startsWith(type));
    
    // 对于图片等二进制内容，或者包含控制字符的内容，使用 base64 编码
    if (mimeType.startsWith('image/') || isBinaryContent || (!isTextContent && bodyBuffer.some(byte => byte <= 0x08 || (byte >= 0x0B && byte <= 0x1F) || byte === 0x7F))) {
        content.encoding = 'base64';
        content.text = bodyBuffer.toString('base64');
    } else {
        // 文本内容直接使用 utf-8 解码
        content.text = bodyBuffer.toString('utf-8');
    }
    
    return {
        status,
        statusText,
        headers,
        content
    };
}

/**
 * 将解析后的 SAZ 数据转换为 HAR 格式
 * @param sazData 解析后的 SAZ 数据
 * @returns HAR 对象
 */
function convertSazDataToHar(sazData: SazFileData[]): HarFile {
    const entries: HarEntry[] = [];
    
    // 按位置排序
    sazData.sort((a, b) => a.position - b.position);
    
    // 合并相同位置的请求和响应
    const mergedData: Record<number, any> = {};
    
    for (const data of sazData) {
        if (!mergedData[data.position]) {
            mergedData[data.position] = {
                position: data.position,
                request: null,
                response: null,
                metadata: null
            };
        }
        
        if (data.raw.request) {
            mergedData[data.position].request = data.raw.request;
        }
        
        if (data.raw.response) {
            mergedData[data.position].response = data.raw.response;
        }
        
        if (data.raw.metadata) {
            mergedData[data.position].metadata = data.raw.metadata;
        }
    }
    
    // 转换为 HAR 条目
    for (const position in mergedData) {
        const item = mergedData[position];
        const request = parseHttpRequest(item.request);
        const response = parseHttpResponse(item.response);
        
        if (request && response) {
            entries.push({
                startedDateTime: new Date().toISOString(),
                time: 0, // 无计时信息
                request,
                response,
                cache: {},
                timings: {}
            });
        }
    }
    
    return {
        log: {
            version: '1.2',
            creator: {
                name: 'service-for-har-saz-converter',
                version: '1.0.0'
            },
            entries
        }
    };
}

/**
 * 转换 SAZ 文件为 HAR 格式
 * @param sazPath SAZ 文件路径
 * @param harPath HAR 文件路径
 */
export async function convertSazToHar(sazPath: string, harPath: string): Promise<void> {
    // 创建临时目录用于解压
    const tempDir = path.join(tmpdir(), `saz-extract-${createHash('md5').update(sazPath).digest('hex')}`);
    
    try {
        // 解压 SAZ 文件
        await extract(sazPath, { dir: tempDir });
        
        // 读取 raw 目录中的文件
        const rawDataDir = path.join(tempDir, 'raw');
        const files = await fs.readdir(rawDataDir);
        
        const sazData: SazFileData[] = [];
        
        // 解析每个文件
        for (const file of files) {
            const filePath = path.join(rawDataDir, file);
            const content = await fs.readFile(filePath);
            const parsedData = parseSazFile(file, content);
            
            if (parsedData) {
                sazData.push(parsedData);
            }
        }
        
        // 转换为 HAR 格式
        const harData = convertSazDataToHar(sazData);
        
        // 写入 HAR 文件
        await fs.writeFile(harPath, JSON.stringify(harData, null, 2), 'utf-8');
    } finally {
        // 清理临时目录
        try {
            await rimraf(tempDir);
        } catch (error) {
            console.warn('Failed to clean up temporary directory:', error);
        }
    }
}
