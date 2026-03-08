import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';
import { convertSazToHar } from '../src/saz-converter.js';

// Helper to create a dummy SAZ file (which is just a zip with a specific structure)
// We'll use a library to zip, but wait, we don't have a zip library except extract-zip.
// We can use the 'zip' command if available on macOS (darwin).
async function createMockSaz(sazPath: string, request: Buffer, response: Buffer) {
    const tempWorkDir = path.join(tmpdir(), `saz-mock-${createHash('md5').update(sazPath).digest('hex')}`);
    const rawDir = path.join(tempWorkDir, 'raw');
    await fs.mkdir(rawDir, { recursive: true });
    
    await fs.writeFile(path.join(rawDir, '01_c.txt'), request);
    await fs.writeFile(path.join(rawDir, '01_s.txt'), response);
    
    // Create the zip file using the shell 'zip' command
    const { execSync } = await import('node:child_process');
    execSync(`zip -r "${sazPath}" raw/`, { cwd: tempWorkDir });
    
    // Clean up
    await fs.rm(tempWorkDir, { recursive: true, force: true });
}

test('SAZ Converter - UTF-8 support', async () => {
    const testDir = path.join(tmpdir(), 'saz-test-utf8');
    await fs.mkdir(testDir, { recursive: true });
    
    const sazPath = path.join(testDir, 'test_utf8.saz');
    const harPath = path.join(testDir, 'test_utf8.har');
    
    const request = Buffer.from('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
    const response = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello UTF-8: 你好');
    
    await createMockSaz(sazPath, request, response);
    
    await convertSazToHar(sazPath, harPath, 'utf-8');
    
    const harContent = JSON.parse(await fs.readFile(harPath, 'utf-8'));
    assert.strictEqual(harContent.log.entries[0].response.content.text, 'Hello UTF-8: 你好');
    
    await fs.rm(testDir, { recursive: true, force: true });
});

test('SAZ Converter - GBK support', async () => {
    const testDir = path.join(tmpdir(), 'saz-test-gbk');
    await fs.mkdir(testDir, { recursive: true });
    
    const sazPath = path.join(testDir, 'test_gbk.saz');
    const harPath = path.join(testDir, 'test_gbk.har');
    
    const request = Buffer.from('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
    // Encode '你好' in GBK
    const gbkBody = Buffer.concat([
        Buffer.from('Hello GBK: '),
        iconv.encode('你好', 'gbk')
    ]);
    const response = Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=gbk\r\n\r\n'),
        gbkBody
    ]);
    
    await createMockSaz(sazPath, request, response);
    
    // Convert with GBK
    await convertSazToHar(sazPath, harPath, 'gbk');
    
    const harContent = JSON.parse(await fs.readFile(harPath, 'utf-8'));
    assert.strictEqual(harContent.log.entries[0].response.content.text, 'Hello GBK: 你好');
    
    await fs.rm(testDir, { recursive: true, force: true });
});
