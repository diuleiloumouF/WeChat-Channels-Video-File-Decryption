/**
 * WeChat Channels Video Decryption API Service
 *
 * 基于 Playwright 浏览器自动化的 RPC 解密服务
 * 通过真实浏览器环境完美兼容微信官方 WASM 模块
 *
 * @author Evil0ctal
 * @license MIT
 */

const express = require('express');
const { chromium } = require('playwright');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 配置文件上传
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// 中间件
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// 静态文件服务 - 提供 wechat_files 目录
app.use('/wechat_files', express.static(path.join(__dirname, 'wechat_files')));

// 全局变量
let browser = null;
let page = null;
let server = null;
let isProcessing = false; // 请求锁
let requestQueue = []; // 请求队列
const getWorkerUrl = () => `http://localhost:${PORT}/worker.html`;

// 页面池配置
const POOL_SIZE = parseInt(process.env.POOL_SIZE) || 3; // 默认3个并发页面
let pagePool = null;

/**
 * 页面池管理器 - 支持并发处理
 */
class PagePool {
    constructor(browser, size) {
        this.browser = browser;
        this.size = size;
        this.pages = [];        // 所有页面
        this.available = [];    // 可用页面队列
        this.waiting = [];      // 等待获取页面的请求
        this.initializing = false;
    }

    /**
     * 初始化页面池
     */
    async initialize() {
        if (this.initializing) return;
        this.initializing = true;

        console.log(`🏊 初始化页面池 (大小: ${this.size})...`);

        for (let i = 0; i < this.size; i++) {
            try {
                const pg = await this._createPage(i);
                this.pages.push(pg);
                this.available.push(pg);
                console.log(`   ✅ 页面 ${i + 1}/${this.size} 已就绪`);
            } catch (error) {
                console.error(`   ❌ 页面 ${i + 1}/${this.size} 创建失败:`, error.message);
            }
        }

        console.log(`🏊 页面池初始化完成，可用页面: ${this.available.length}/${this.size}`);
        this.initializing = false;
    }

    /**
     * 创建单个页面
     */
    async _createPage(index) {
        const context = await this.browser.newContext({
            // 增加内存限制以支持大文件处理
            javaScriptEnabled: true,
        });

        const pg = await context.newPage();
        pg._poolIndex = index;
        pg._context = context;

        await pg.goto(getWorkerUrl());

        // 等待 WASM 加载
        await pg.waitForFunction(
            () => typeof Module !== 'undefined' && typeof Module.WxIsaac64 !== 'undefined',
            { timeout: 60000 }
        );

        return pg;
    }

    /**
     * 获取一个可用页面（如果没有则等待）
     */
    async acquire(timeout = 600000) {
        // 如果有可用页面，直接返回
        if (this.available.length > 0) {
            const pg = this.available.shift();
            console.log(`🔓 获取页面 #${pg._poolIndex}，剩余可用: ${this.available.length}`);
            return pg;
        }

        // 没有可用页面，加入等待队列
        console.log(`⏳ 页面池已满，等待中... (等待队列: ${this.waiting.length + 1})`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.waiting.findIndex(w => w.resolve === resolve);
                if (index > -1) {
                    this.waiting.splice(index, 1);
                }
                reject(new Error(`获取页面超时 (${timeout}ms)，请稍后重试`));
            }, timeout);

            this.waiting.push({
                resolve: (pg) => {
                    clearTimeout(timer);
                    resolve(pg);
                },
                reject
            });
        });
    }

    /**
     * 归还页面到池中
     */
    release(pg) {
        // 检查页面是否有效
        if (!pg || pg.isClosed()) {
            console.log(`⚠️ 页面 #${pg?._poolIndex} 已关闭，将重建`);
            this._rebuildPage(pg?._poolIndex);
            return;
        }

        // 如果有等待的请求，直接给它
        if (this.waiting.length > 0) {
            const waiter = this.waiting.shift();
            console.log(`🔄 页面 #${pg._poolIndex} 直接分配给等待的请求`);
            waiter.resolve(pg);
            return;
        }

        // 否则放回可用队列
        this.available.push(pg);
        console.log(`🔙 归还页面 #${pg._poolIndex}，可用: ${this.available.length}`);
    }

    /**
     * 重建损坏的页面
     */
    async _rebuildPage(index) {
        if (index === undefined) return;

        try {
            console.log(`🔄 重建页面 #${index}...`);
            const pg = await this._createPage(index);
            this.pages[index] = pg;

            // 如果有等待的请求，直接给它
            if (this.waiting.length > 0) {
                const waiter = this.waiting.shift();
                waiter.resolve(pg);
            } else {
                this.available.push(pg);
            }
            console.log(`✅ 页面 #${index} 重建完成`);
        } catch (error) {
            console.error(`❌ 页面 #${index} 重建失败:`, error.message);
        }
    }

    /**
     * 获取池状态
     */
    getStatus() {
        return {
            total: this.size,
            available: this.available.length,
            inUse: this.size - this.available.length,
            waiting: this.waiting.length
        };
    }

    /**
     * 关闭所有页面
     */
    async close() {
        for (const pg of this.pages) {
            try {
                if (pg && !pg.isClosed()) {
                    await pg.close();
                    // 关闭context
                    if (pg._context) {
                        await pg._context.close();
                    }
                }
            } catch (e) {
                // 忽略关闭错误
            }
        }
        this.pages = [];
        this.available = [];
    }
}

/**
 * 使用页面池执行任务
 */
async function withPoolPage(fn) {
    if (!pagePool) {
        throw new Error('页面池未初始化');
    }

    const pg = await pagePool.acquire();
    try {
        return await fn(pg);
    } catch (error) {
        // 如果是页面关闭错误，标记页面需要重建
        if (error.message && error.message.includes('closed')) {
            console.log(`⚠️ 页面 #${pg._poolIndex} 执行出错，将重建`);
            pagePool._rebuildPage(pg._poolIndex);
            throw error;
        }
        throw error;
    } finally {
        pagePool.release(pg);
    }
}

/**
 * 带超时的 page.evaluate (用于页面池)
 */
async function evaluateWithTimeoutOnPage(pg, pageFunction, arg, timeout = 30000) {
    return Promise.race([
        pg.evaluate(pageFunction, arg),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`操作超时 (${timeout}ms)`)), timeout)
        )
    ]);
}

/**
 * 检查页面是否健康可用
 */
async function isPageHealthy() {
    if (!browser || !page) {
        return false;
    }
    try {
        // 尝试执行简单操作来检查页面是否有效（带5秒超时）
        await Promise.race([
            page.evaluate(() => true),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('健康检查超时')), 5000)
            )
        ]);
        return true;
    } catch (error) {
        console.log('⚠️ 页面健康检查失败:', error.message);
        return false;
    }
}

/**
 * 重置浏览器和页面
 */
async function resetBrowser() {
    console.log('🔄 重置浏览器...');

    // 先尝试关闭旧的浏览器
    if (browser) {
        try {
            await browser.close();
        } catch (e) {
            // 忽略关闭错误
        }
    }

    browser = null;
    page = null;

    // 重新初始化
    await initBrowser();
    console.log('✅ 浏览器重置完成');
}

/**
 * 确保页面可用，如果不可用则重置
 */
async function ensurePageReady() {
    if (!await isPageHealthy()) {
        await resetBrowser();
    }
}

/**
 * 带锁的执行函数，确保同一时间只有一个请求在使用页面
 */
async function withPageLock(fn) {
    return new Promise((resolve, reject) => {
        const execute = async () => {
            isProcessing = true;
            try {
                await ensurePageReady();
                const result = await fn();
                resolve(result);
            } catch (error) {
                // 如果是页面关闭相关错误，标记需要重置
                if (error.message && error.message.includes('closed')) {
                    console.log('⚠️ 检测到页面已关闭，将在下次请求时重置');
                    browser = null;
                    page = null;
                }
                reject(error);
            } finally {
                isProcessing = false;
                // 处理队列中的下一个请求
                if (requestQueue.length > 0) {
                    const next = requestQueue.shift();
                    next();
                }
            }
        };

        if (isProcessing) {
            // 如果正在处理，加入队列等待
            console.log('⏳ 请求排队中，当前队列长度:', requestQueue.length + 1);
            requestQueue.push(execute);
        } else {
            execute();
        }
    });
}

/**
 * 带超时的 page.evaluate 包装函数
 */
async function evaluateWithTimeout(pageFunction, arg, timeout = 30000) {
    return Promise.race([
        page.evaluate(pageFunction, arg),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`操作超时 (${timeout}ms)`)), timeout)
        )
    ]);
}

/**
 * 初始化 Playwright 浏览器
 */
async function initBrowser() {
    if (browser && page) {
        return;
    }

    console.log('🚀 启动 Playwright 浏览器...');

    browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--js-flags=--max-old-space-size=4096',  // 增加V8内存限制到4GB
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    });

    page = await browser.newPage();

    // 加载 RPC Worker 页面（通过 HTTP 以支持本地 WASM 文件加载）
    await page.goto(getWorkerUrl());

    // 等待 WASM 模块完全加载 (等待 Module.WxIsaac64 可用)
    console.log('⏳ 等待 WASM 模块加载...');
    await page.waitForFunction(
        () => typeof Module !== 'undefined' && typeof Module.WxIsaac64 !== 'undefined',
        { timeout: 60000 }
    );

    const status = await page.evaluate(() => window.checkWasmStatus());
    console.log(`   WASM 模块状态: ${JSON.stringify(status)}`);

    // 检查是否使用 CDN
    const usingCdn = await page.evaluate(() => window.WASM_USING_CDN);
    console.log('✅ Playwright 浏览器已就绪');
    console.log(`   Worker URL: ${getWorkerUrl()}`);
    console.log(`   WASM Source: ${usingCdn ? 'WeChat CDN (fallback)' : 'Local files'}`);
    console.log(`   WASM Status: ${status.loaded ? 'Loaded' : 'Not Loaded'}`);
}

/**
 * 请求日志中间件
 */
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ==================== API 路由 ====================

/**
 * GET /health
 * 健康检查
 */
app.get('/health', async (req, res) => {
    try {
        if (!page) {
            await initBrowser();
        }

        const wasmStatus = await page.evaluate(() => window.checkWasmStatus());

        res.json({
            status: 'ok',
            service: 'wechat-decrypt-api',
            version: '2.0.0',
            engine: 'playwright',
            wasm: wasmStatus,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
});

/**
 * GET /
 * API 文档页面
 */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'docs.html'));
});

/**
 * GET /worker.html
 * RPC Worker 页面（供 Playwright 浏览器加载）
 */
app.get('/worker.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'worker.html'));
});

/**
 * GET /api/info
 * 服务信息（JSON 格式）
 */
app.get('/api/info', (req, res) => {
    res.json({
        service: 'WeChat Channels Video Decryption API',
        version: '2.0.0',
        engine: 'Playwright + Chromium',
        author: 'Evil0ctal',
        github: 'https://github.com/Evil0ctal/WeChat-Channels-Video-File-Decryption',
        endpoints: {
            health: 'GET /health',
            poolStatus: 'GET /api/pool-status',
            keystream: 'POST /api/keystream',
            decrypt: 'POST /api/decrypt (串行)',
            decryptConcurrent: 'POST /api/decrypt-concurrent (并发)'
        }
    });
});

/**
 * POST /api/keystream
 * 生成密钥流
 */
app.post('/api/keystream', async (req, res) => {
    try {
        const { decode_key, format = 'hex' } = req.body;

        if (!decode_key) {
            return res.status(400).json({ error: '缺少 decode_key 参数' });
        }

        if (!['hex', 'base64'].includes(format)) {
            return res.status(400).json({
                error: '无效的 format 参数',
                valid_formats: ['hex', 'base64']
            });
        }

        console.log(`🔑 生成密钥流: decode_key=${decode_key}, format=${format}`);

        // 使用锁机制确保串行处理
        const result = await withPageLock(async () => {
            const startTime = Date.now();

            // 调用浏览器中的 RPC 方法（带超时保护）
            const keystreamBase64 = await evaluateWithTimeout(
                async (key) => await window.generateKeystream(key),
                decode_key,
                30000
            );

            const duration = Date.now() - startTime;

            // 格式转换
            let keystream;
            if (format === 'hex') {
                const binary = atob(keystreamBase64);
                keystream = Array.from(binary, c =>
                    c.charCodeAt(0).toString(16).padStart(2, '0')
                ).join('');
            } else {
                keystream = keystreamBase64;
            }

            console.log(`✅ 密钥流生成成功，耗时 ${duration}ms`);

            return {
                decode_key,
                keystream,
                format,
                size: 131072,
                duration_ms: duration,
                timestamp: new Date().toISOString()
            };
        });

        res.json(result);

    } catch (error) {
        console.error('❌ 密钥流生成失败:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/decrypt
 * 完整解密视频
 */
app.post('/api/decrypt', upload.single('video'), async (req, res) => {
    try {
        const { decode_key } = req.body;
        const videoFile = req.file;

        if (!decode_key) {
            return res.status(400).json({ error: '缺少 decode_key 参数' });
        }

        if (!videoFile) {
            return res.status(400).json({ error: '缺少视频文件' });
        }

        console.log(`📹 解密请求:`);
        console.log(`   decode_key: ${decode_key}`);
        console.log(`   文件: ${videoFile.originalname} (${(videoFile.size / 1024 / 1024).toFixed(2)} MB)`);

        // 使用锁机制确保串行处理
        const result = await withPageLock(async () => {
            const startTime = Date.now();

            // 步骤 1: 生成密钥流
            console.log('   [1/2] 生成密钥流...');
            const keystreamHex = await evaluateWithTimeout(
                async (key) => await window.generateKeystreamHex(key),
                decode_key,
                30000
            );

            // 步骤 2: 在 Node.js 端执行 XOR 解密（避免传输大文件到浏览器）
            console.log('   [2/2] 执行 XOR 解密 (Node.js)...');
            const keystream = Buffer.from(keystreamHex, 'hex');
            const encrypted = videoFile.buffer;
            const decrypted = Buffer.alloc(encrypted.length);

            // 微信只加密前128KB，所以只解密前128KB
            const KEYSTREAM_SIZE = 131072;
            const decryptLen = Math.min(KEYSTREAM_SIZE, encrypted.length);

            // XOR 解密前128KB
            for (let i = 0; i < decryptLen; i++) {
                decrypted[i] = encrypted[i] ^ keystream[i];
            }

            // 复制剩余未加密部分
            for (let i = decryptLen; i < encrypted.length; i++) {
                decrypted[i] = encrypted[i];
            }

            // 验证 MP4 签名
            const ftyp = decrypted.toString('utf8', 4, 8);
            if (ftyp !== 'ftyp') {
                throw new Error('解密失败：未找到 MP4 ftyp 签名，请检查 decode_key');
            }

            const duration = Date.now() - startTime;
            console.log(`✅ 解密成功，耗时 ${duration}ms`);

            return { decrypted, duration };
        });

        // 返回解密后的视频
        res.set({
            'Content-Type': 'video/mp4',
            'Content-Length': result.decrypted.length,
            'Content-Disposition': `attachment; filename="decrypted_${Date.now()}.mp4"`,
            'X-Decrypt-Duration': result.duration
        });

        res.send(result.decrypted);

    } catch (error) {
        console.error('❌ 解密失败:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/decrypt-concurrent
 * 并发解密视频（使用页面池）
 */
app.post('/api/decrypt-concurrent', upload.single('video'), async (req, res) => {
    try {
        const { decode_key } = req.body;
        const videoFile = req.file;

        if (!decode_key) {
            return res.status(400).json({ error: '缺少 decode_key 参数' });
        }

        if (!videoFile) {
            return res.status(400).json({ error: '缺少视频文件' });
        }

        if (!pagePool) {
            return res.status(503).json({ error: '页面池未初始化，请稍后重试' });
        }

        console.log(`📹 [并发] 解密请求:`);
        console.log(`   decode_key: ${decode_key}`);
        console.log(`   文件: ${videoFile.originalname} (${(videoFile.size / 1024 / 1024).toFixed(2)} MB)`);
        console.log(`   页面池状态: ${JSON.stringify(pagePool.getStatus())}`);

        // 使用页面池执行（支持并发）
        const result = await withPoolPage(async (pg) => {
            const startTime = Date.now();

            // 步骤 1: 生成密钥流
            console.log(`   [页面#${pg._poolIndex}] [1/2] 生成密钥流...`);
            const keystreamHex = await evaluateWithTimeoutOnPage(
                pg,
                async (key) => await window.generateKeystreamHex(key),
                decode_key,
                30000
            );

            // 步骤 2: 在 Node.js 端执行 XOR 解密（避免传输大文件到浏览器）
            console.log(`   [页面#${pg._poolIndex}] [2/2] 执行 XOR 解密 (Node.js)...`);
            const keystream = Buffer.from(keystreamHex, 'hex');
            const encrypted = videoFile.buffer;
            const decrypted = Buffer.alloc(encrypted.length);

            // 微信只加密前128KB，所以只解密前128KB
            const KEYSTREAM_SIZE = 131072;
            const decryptLen = Math.min(KEYSTREAM_SIZE, encrypted.length);

            // XOR 解密前128KB
            for (let i = 0; i < decryptLen; i++) {
                decrypted[i] = encrypted[i] ^ keystream[i];
            }

            // 复制剩余未加密部分
            for (let i = decryptLen; i < encrypted.length; i++) {
                decrypted[i] = encrypted[i];
            }

            // 验证 MP4 签名
            const ftyp = decrypted.toString('utf8', 4, 8);
            if (ftyp !== 'ftyp') {
                throw new Error('解密失败：未找到 MP4 ftyp 签名，请检查 decode_key');
            }

            const duration = Date.now() - startTime;
            console.log(`✅ [页面#${pg._poolIndex}] 解密成功，耗时 ${duration}ms`);

            return { decrypted, duration };
        });

        // 返回解密后的视频
        res.set({
            'Content-Type': 'video/mp4',
            'Content-Length': result.decrypted.length,
            'Content-Disposition': `attachment; filename="decrypted_${Date.now()}.mp4"`,
            'X-Decrypt-Duration': result.duration
        });

        res.send(result.decrypted);

    } catch (error) {
        console.error('❌ [并发] 解密失败:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/pool-status
 * 获取页面池状态
 */
app.get('/api/pool-status', (req, res) => {
    if (!pagePool) {
        return res.status(503).json({
            error: '页面池未初始化',
            status: null
        });
    }

    res.json({
        status: 'ok',
        pool: pagePool.getStatus(),
        timestamp: new Date().toISOString()
    });
});

/**
 * 404 处理
 */
app.use((req, res) => {
    res.status(404).json({
        error: '接口不存在',
        path: req.path,
        available: [
            'GET /',
            'GET /health',
            'GET /api/pool-status',
            'POST /api/keystream',
            'POST /api/decrypt',
            'POST /api/decrypt-concurrent'
        ]
    });
});

/**
 * 错误处理
 */
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);

    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                error: '文件过大',
                limit: '500MB'
            });
        }
    }

    res.status(500).json({ error: err.message });
});

// ==================== 启动服务 ====================

(async () => {
    try {
        console.log('╔═══════════════════════════════════════════════════════════╗');
        console.log('║   WeChat Channels Video Decryption API (Playwright)      ║');
        console.log('╚═══════════════════════════════════════════════════════════╝\n');

        // 先启动 HTTP 服务器（浏览器需要从这里加载 worker.html）
        server = app.listen(PORT, async () => {
            console.log('✅ HTTP 服务器已启动');
            console.log(`📡 监听端口: ${PORT}`);
            console.log(`🌐 访问地址: http://localhost:${PORT}\n`);

            try {
                // 初始化浏览器（用于串行接口）
                await initBrowser();

                // 初始化页面池（用于并发接口）
                pagePool = new PagePool(browser, POOL_SIZE);
                await pagePool.initialize();

                console.log('\n✅ 服务完全就绪');
                console.log('\n📚 API 端点:');
                console.log('   GET  /                    服务信息');
                console.log('   GET  /health              健康检查');
                console.log('   GET  /api/pool-status     页面池状态');
                console.log('   POST /api/keystream       生成密钥流');
                console.log('   POST /api/decrypt         解密视频 (串行)');
                console.log('   POST /api/decrypt-concurrent  解密视频 (并发)');
                console.log(`\n🏊 页面池大小: ${POOL_SIZE} (可通过 POOL_SIZE 环境变量配置)`);
                console.log('🎭 使用 Playwright 浏览器执行 WASM');
                console.log('   100% 兼容微信官方模块\n');
            } catch (error) {
                console.error('❌ 浏览器初始化失败:', error);
                process.exit(1);
            }
        });

    } catch (error) {
        console.error('❌ 启动失败:', error);
        process.exit(1);
    }
})();

// 优雅关闭
async function gracefulShutdown() {
    console.log('\n👋 正在关闭服务...');

    // 关闭页面池
    if (pagePool) {
        console.log('   关闭页面池...');
        await pagePool.close();
    }

    // 关闭浏览器
    if (browser) {
        console.log('   关闭浏览器...');
        await browser.close();
    }

    console.log('✅ 服务已关闭');
    process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
