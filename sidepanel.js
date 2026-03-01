document.addEventListener('DOMContentLoaded', () => {
    const statusEl = document.getElementById('status');
    // const connectBtn = document.getElementById('connectBtn'); // Removed

    // 新增：初始化时隐藏日志面板，保证界面清爽
    const logContainer = document.getElementById('log-container');
    if (logContainer) {
        logContainer.style.display = 'none';
        console.log('[Init] Log container hidden by default.');
    }

    // 标记是否有 .base 文件数据（防止实时监听覆盖）
    let hasBaseFileData = false;

    // 1. 初始化并尝试加载当前上下文数据
    // 1. 初始化并尝试加载当前上下文数据
    let lastProjectId = null; // 追踪当前项目 ID

    // 初始化设置面板中的 System Prompt
    initSettings();

    // 初始化时检查项目名称
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            checkConnection(tabs[0].id);
            fetchProjectName(tabs[0].id);
            checkProjectSwitch(tabs[0]);
        }
    });

    initProject();

    // 监听 Tab 更新 (URL 变化)
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (tab.active && (changeInfo.url || changeInfo.status === 'complete')) {
            checkProjectSwitch(tab);
        }
    });

    // 监听 Tab 切换
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
        try {
            const tab = await chrome.tabs.get(activeInfo.tabId);
            checkProjectSwitch(tab);
        } catch (e) { console.error(e); }
    });

    // 检查是否需要切换项目
    async function checkProjectSwitch(tab) {
        if (!tab || !tab.url) return;

        // 简单判断是否是飞书多维表格
        if (!tab.url.includes('/base/')) return;

        const newProjectId = ProjectManager.getAppTokenFromUrl(tab.url);

        // 如果项目 ID 变化，或者之前没有 ID (首次加载)
        if (newProjectId && newProjectId !== lastProjectId) {
            console.log(`[Sidepanel] Detected project switch: ${lastProjectId} -> ${newProjectId}`);
            lastProjectId = newProjectId;

            // 重置 UI 状态
            hasBaseFileData = false;
            statusEl.textContent = '切换中...';
            statusEl.className = 'status-badge';
            const docContainer = document.getElementById('markdown-preview');
            if (docContainer) {
                docContainer.innerHTML = '<div style="padding: 20px; color: #666;">⏳ 切换中...</div>';
                // 确保容器显示，否则看不见提示
                const previewCard = document.getElementById('preview-card-container');
                if (previewCard) previewCard.style.display = 'block';
            }

            // 重新初始化
            await initProject();
        }
    }

    // 新增：检查连接状态 (含自动修复)
    async function checkConnection(tabId) {
        // 1. 尝试直接 PING
        try {
            await chrome.tabs.sendMessage(tabId, { action: 'PING' });
            return true;
        } catch (e) {
            // PING 失败，尝试注入脚本
            console.log('PING failed, trying to inject script...', e.message);
        }

        // 2. 尝试注入 Content Script
        try {
            // 先获取标签页信息，检查是否为飞书页面
            const tab = await chrome.tabs.get(tabId);
            if (!tab.url || !tab.url.includes('feishu.cn/base/')) {
                console.log('Not a Feishu Bitable page, skipping script injection');
                return false;
            }

            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            // 等待脚本执行
            await new Promise(r => setTimeout(r, 200));

            // 3. 再次 PING
            await chrome.tabs.sendMessage(tabId, { action: 'PING' });
            return true;
        } catch (e) {
            console.log('Connection check failed (expected on non-Feishu pages):', e.message);
            // 不显示错误，这是正常的，当页面不是飞书页面或权限不足时会发生
            return false;
        }
    }

    // 新增：显示/隐藏刷新警告
    function showRefreshWarning(show) {
        let warningEl = document.getElementById('refresh-warning');
        if (!warningEl) {
            // 创建警告栏
            warningEl = document.createElement('div');
            warningEl.id = 'refresh-warning';
            warningEl.style.cssText = `
                background-color: #ffeceb;
                color: #d93025;
                padding: 10px 16px;
                font-size: 13px;
                border-bottom: 1px solid #fce8e6;
                display: flex;
                align-items: center;
                gap: 8px;
            `;
            warningEl.innerHTML = `
                <span>⚠️ 检测到连接未建立，请刷新飞书页面以激活插件。</span>
                <button id="refresh-page-btn" style="border:1px solid #d93025;background:#fff;color:#d93025;border-radius:4px;padding:2px 8px;cursor:pointer;">刷新页面</button>
            `;
            // 插入到 header 下方
            const header = document.querySelector('.app-header');
            if (header && header.nextSibling) {
                header.parentNode.insertBefore(warningEl, header.nextSibling);
            }
            // 绑定刷新按钮: 优先尝试注入脚本，失败则刷新页面
            warningEl.querySelector('#refresh-page-btn').addEventListener('click', async () => {
                const btn = warningEl.querySelector('#refresh-page-btn');
                const originalText = btn.textContent;
                btn.textContent = '连接中...';
                btn.disabled = true;

                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (!tab) throw new Error('No active tab');

                    // 1. 尝试注入 Content Script
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        files: ['content.js']
                    });

                    // 2. 等待一下让脚本执行
                    await new Promise(r => setTimeout(r, 500));

                    // 3. 再次检查连接
                    const isConnected = await checkConnection(tab.id);
                    if (isConnected) {
                        showRefreshWarning(false);
                        btn.textContent = originalText;
                        btn.disabled = false;

                        // 成功后重新初始化
                        await initProject();
                        return;
                    }
                } catch (e) {
                    console.log('Injection failed, fallback to reload', e);
                }

                // 4. 如果注入失败或连接仍未建立，回退到刷新页面
                if (tab) chrome.tabs.reload(tab.id);
            });
        }
        warningEl.style.display = show ? 'flex' : 'none';
    }

    async function initProject() {
        try {
            // 重置 Chat 状态，确保切换项目后重新加载会话
            chatInitialized = false;
            if (typeof AIChat !== 'undefined') {
                AIChat.currentSessionId = null;
                AIChat.sessions = [];
            }
            // 如果当前在 Chat 标签页，清空一下，等待重新加载
            const chatContainer = document.getElementById('chat-messages');
            if (chatContainer) chatContainer.innerHTML = '';

            await ProjectManager.init();

            // 检查连接: 先尝试 ping 一下当前 Tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.url && tab.url.includes('/base/')) {
                const isConnected = await checkConnection(tab.id);
                if (!isConnected) {
                    showRefreshWarning(true);
                    // 就算没连接，也继续尝试显示已有数据，不 block
                } else {
                    showRefreshWarning(false);
                    // 尝试获取项目名称 (Moved to after DB load to avoid race condition)
                }
            }

            // 尝试获取当前 Tab 的项目 ID
            const currentProjectId = await ProjectManager.getActiveProjectId();

            // 同步 lastProjectId (防止重复触发)
            if (currentProjectId) lastProjectId = currentProjectId;

            // 如果当前恰好在 Chat 界面，立即刷新 Chat
            const activeTab = document.querySelector('.main-tab-btn.active');
            if (activeTab && activeTab.dataset.tab === 'chat') {
                initChat();
            }

            addLog(`🔗 当前上下文 ID: ${currentProjectId || '未识别 (请打开多维表格)'}`);

            if (currentProjectId) {
                const projectData = await ProjectManager.getProjectData(currentProjectId);
                if (projectData) {
                    addLog(`📂 加载项目: ${projectData.info.name} (v${projectData.version.version})`);

                    if (projectData.info.name && projectData.info.name !== '未命名项目') {
                        updateProjectNameUI(projectData.info.name);
                    }

                    // 延迟一点获取最新标题，确保覆盖 DB 的旧标题
                    if (tab) fetchProjectName(tab.id);

                    // 标记已有数据
                    hasBaseFileData = true;

                    // [Project Data] 记录原始数据与文档
                    if (projectData.rawData) {
                        window.currentRawData = projectData.rawData;
                    }
                    if (projectData.documents) {
                        window.currentDocuments = projectData.documents;
                    }

                    // [Context Slicing] 加载预处理切片 (从新版 version.slices 中读取)
                    if (projectData.version && projectData.version.slices) {
                        window.currentSlices = projectData.version.slices;
                    } else {
                        window.currentSlices = { tables: {}, workflows: {} };
                    }

                    // 恢复显示
                    displayCachedResults(projectData.documents);

                    // [Context Slicing] 初始化上下文切片逻辑 (防退化：放在正常显示之后，且用 try-catch)
                    try {
                        initContextSlicing();
                    } catch (err) {
                        console.error('[Context Slicing] Init failed:', err);
                        // 不影响主流程，仅在控制台报错
                    }

                    // 更新状态
                    statusEl.textContent = `已加载: ${projectData.info.name}`;
                    statusEl.className = 'status-badge status-connected';
                } else {
                    // 本地无数据
                    statusEl.textContent = '等待同步';
                    statusEl.className = 'status-badge';
                    updateProjectNameUI('未命名多维表格');
                    if (tab) fetchProjectName(tab.id);
                    addLog('ℹ️ 暂无当前项目的本地数据，请先同步/上传');
                }
            }
        } catch (e) {
            console.error('Project init failed:', e);
            addLog(`❌ 初始化失败: ${e.message}`);
        }
    }

    // 绑定刷新按钮
    const refreshCtxBtn = document.getElementById('refresh-ctx-btn');
    if (refreshCtxBtn) {
        refreshCtxBtn.addEventListener('click', async () => {
            const btn = document.getElementById('refresh-ctx-btn');
            btn.style.transform = 'rotate(180deg)';
            setTimeout(() => btn.style.transform = 'none', 500);

            addLog('🔄 手动刷新上下文...');
            // 清空旧数据
            const docContainer = document.getElementById('markdown-preview');
            if (docContainer) docContainer.innerHTML = '正在刷新...';
            hasBaseFileData = false;

            await initProject();
        });
    }

    // 获取并显示项目名称
    async function fetchProjectName(tabId) {
        if (!tabId) return;
        try {
            const response = await chrome.tabs.sendMessage(tabId, { action: 'GET_TITLE' });
            if (chrome.runtime.lastError) { 
                // 忽略连接错误，这是正常的，特别是当内容脚本还未加载时
                console.log('[Sidepanel] Could not fetch title (content script not ready)');
                return;
            }
            if (response && response.title) {
                console.log(`[Sidepanel] Fetched live title: ${response.title}`);

                // 1. 更新 UI
                updateProjectNameUI(response.title);

                // 2. 同步保存到数据库 (如果当前有项目 ID)
                if (lastProjectId) {
                    const project = await DB.get('projects', lastProjectId);
                    if (project && project.name !== response.title) {
                        project.name = response.title;
                        await DB.put('projects', project);
                        console.log(`[Sidepanel] Updated project name in DB: ${response.title}`);
                    }
                }
            }
        } catch (e) {
            console.log('Fetch title failed (content script not connected):', e.message);
            // 不显示错误，这是正常的，当内容脚本未加载时会发生
        }
    }

    function updateProjectNameUI(name) {
        // 直接替换主标题
        const titleEl = document.querySelector('.app-title');
        if (titleEl) {
            titleEl.textContent = name;
            titleEl.title = name;
        }

        // 隐藏原来的小 tag (如果有)
        const smallTag = document.getElementById('project-name-display');
        if (smallTag) {
            smallTag.style.display = 'none';
        }
    }

    // 2. 按钮改为“清空数据” (Moved to Settings)

    // 3. 同步按钮逻辑
    const syncBtn = document.getElementById('sync-btn');
    if (syncBtn) {
        syncBtn.addEventListener('click', async () => {
            addLog('🔄 开始自动同步...');

            // 再次检查连接
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
                const isConnected = await checkConnection(tab.id);
                if (!isConnected) {
                    showRefreshWarning(true);
                    addLog('❌ 连接未建立，请先刷新页面');
                    // alert('插件未连接到页面，请先刷新飞书页面。'); // 可选，避免弹窗打扰
                    return;
                }
            }

            syncBtn.disabled = true;
            syncBtn.innerHTML = '<span style="font-size: 16px;">⏳</span><span>同步中...</span>';

            try {
                // 1. 获取当前 Tab
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) throw new Error('无法获取当前标签页');

                // 检查是否在飞书多维表格页面
                if (!tab.url?.includes('feishu.cn/base/')) {
                    throw new Error('请先打开飞书多维表格页面');
                }

                // 2. 向 Content Script 发送同步指令
                addLog('📤 发送同步指令...');
                await chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_SYNC' });
                // 后续由 message listener 处理反馈

            } catch (e) {
                console.error('Sync failed:', e);
                addLog(`❌ 同步失败: ${e.message}`);

                if (e.message.includes('Receiving end does not exist')) {
                    addLog('⚠️ 请刷新飞书页面后重试');
                } else {
                    addLog('💡 请手动下载：点击 ... -> 导出 -> 仅数据结构');
                }

                syncBtn.disabled = false;
                syncBtn.innerHTML = '<span style="font-size: 16px;">🔄</span><span>一键同步</span>';
            }
        });
    }
    /**
     * 保存数据到本地存储 (已废弃，保留空函数防报错，或彻底移除调用)
     */
    function saveToStorage(cacheData) {
        // Legacy support removed. Now handled by ProjectManager.saveVersion directly via Sync/Upload.
    }

    /**
     * 从本地存储加载数据 (已替换为 initProject)
     */
    function loadFromStorage() {
        // Legacy
    }

    // 监听来自后台的数据更新通知
    chrome.runtime.onMessage.addListener((request) => {
        // 实时标题更新 (New)
        if (request.action === 'TITLE_UPDATED' && request.title) {
            console.log(`[Sidepanel] Real-time title update: ${request.title}`);
            updateProjectNameUI(request.title);
            // 同时也保存到 DB
            if (typeof lastProjectId !== 'undefined' && lastProjectId) {
                DB.get('projects', lastProjectId).then(project => {
                    if (project && project.name !== request.title) {
                        project.name = request.title;
                        DB.put('projects', project);
                        console.log(`[Sidepanel] DB updated via real-time sync`);
                    }
                });
            }
        }

        /* 
        if (request.action === 'DATA_UPDATED') {
            // ...
        }
        */

        if (request.action === 'UI_ADD_LOG') {
            addLog(`🔍 ${request.log}`);
        }

        // 同步下载状态消息
        if (request.action === 'SYNC_DOWNLOAD_TRIGGERED') {
            addLog('✅ 下载已触发，请查看下载文件夹');
            addLog('💡 下载完成后，请将 .base 文件拖入上方区域');

            // 更新同步按钮状态
            const syncBtn = document.getElementById('sync-btn');
            if (syncBtn) {
                syncBtn.innerHTML = '<span style="font-size: 16px;">✅</span><span>下载已触发</span>';
                setTimeout(() => {
                    syncBtn.innerHTML = '<span style="font-size: 16px;">🔄</span><span>一键同步</span>';
                    syncBtn.disabled = false;
                }, 3000);
            }
        }

        if (request.action === 'SYNC_DOWNLOAD_FAILED') {
            addLog(`❌ 自动下载失败: ${request.error}`);
            addLog('💡 请手动下载：点击右上角 ... -> 导出 -> 仅数据结构');

            const syncBtn = document.getElementById('sync-btn');
            if (syncBtn) {
                syncBtn.innerHTML = '<span style="font-size: 16px;">🔄</span><span>一键同步</span>';
                syncBtn.disabled = false;
            }
        }

        // 接收拦截到的文件
        if (request.action === 'SYNC_FILE_RECEIVED') {
            addLog(`📥 收到自动同步文件 (${(request.size / 1024).toFixed(1)} KB)`);

            // 将 Base64 转换为文本 (因为 BaseFileParser 期望文本内容)
            // base64 格式通常为 "data:application/octet-stream;base64,AAAA..."
            const base64Content = request.base64.split(',')[1];

            // 解码 Base64
            const binaryString = atob(base64Content);

            // 针对中文内容的解码处理 (如果是文本文件)
            try {
                // 使用 TextDecoder 处理 UTF-8
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                const decodedContent = new TextDecoder('utf-8').decode(bytes);

                // 复用文件处理逻辑
                processFileContent(decodedContent, 'Auto-Sync.base');

                // 更新按钮状态
                const syncBtn = document.getElementById('sync-btn');
                if (syncBtn) {
                    syncBtn.innerHTML = '<span style="font-size: 16px;">✨</span><span>同步完成</span>';
                    setTimeout(() => {
                        syncBtn.innerHTML = '<span style="font-size: 16px;">🔄</span><span>一键同步</span>';
                        syncBtn.disabled = false;
                    }, 3000);
                }

            } catch (e) {
                addLog(`❌ 文件解码失败: ${e.message}`);
                console.error(e);
            }
        }
    });

    function updateUI(context) {
        if (context && context.viewMeta) {
            try {
                document.getElementById('status').textContent = '已获取字段定义';
                document.getElementById('status').className = 'status-badge status-connected';

                // 使用 Parser 解析数据
                addLog('⚙️ 开始解析字段表...');
                const md = FeishuParser.parseFieldTable(context.viewMeta);

                let previewEl = document.getElementById('markdown-preview');
                if (!previewEl) {
                    // 自愈逻辑：如果找不到元素，尝试重建
                    const container = document.querySelector('.container');
                    if (container) {
                        const card = document.createElement('div');
                        card.className = 'card';
                        previewEl = document.createElement('div');
                        previewEl.id = 'markdown-preview';
                        previewEl.textContent = '正在重新渲染...';
                        card.appendChild(previewEl);
                        container.insertBefore(card, document.getElementById('log-container') || container.lastChild);
                        addLog('🔧 已自动修复丢失的界面元素');
                    }
                }

                if (previewEl) {
                    previewEl.textContent = md;
                    // 显示容器
                    const previewCard = document.getElementById('preview-card-container');
                    if (previewCard) previewCard.style.display = 'block';
                    addLog('✅ 解析完成，已渲染');
                } else {
                    addLog('❌ 无法修复界面元素，请彻底重启插件');
                }
            } catch (e) {
                addLog(`❌ 解析错误: ${e.message}`);
                console.error(e);
            }
        } else {
            addLog('⚠️ 数据包为空或无 viewMeta');
        }
    }

    /**
     * 添加日志到界面日志面板和控制台
     * 同时在 UI 日志容器和 DevTools Console 显示日志信息
     */
    function addLog(msg) {
        // 输出到控制台
        console.log(`[Sidepanel Log] ${msg}`);

        // 输出到界面日志面板
        const container = document.getElementById('log-container');
        if (!container) return;

        // 【修改】隐藏日志面板下保持隐藏状态，但依旧生成 DOM 供需要时查看（如下面代码）
        const log = document.createElement('div');
        log.style.cssText = 'font-size: 11px; color: #555; padding: 3px 6px; border-bottom: 1px solid #f0f0f0; word-break: break-all;';
        log.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        container.prepend(log);

        // 限制日志条数，避免 DOM 过多
        while (container.children.length > 50) {
            container.removeChild(container.lastChild);
        }
    }

    // ========== 文件上传功能 ==========
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');

    if (uploadZone && fileInput) {
        // 点击上传
        uploadZone.addEventListener('click', () => fileInput.click());

        // 拖拽效果
        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.classList.add('dragover');
        });
        uploadZone.addEventListener('dragleave', () => {
            uploadZone.classList.remove('dragover');
        });

        // 拖拽放下
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0) handleFileUpload(files[0]);
        });

        // 文件选择
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) handleFileUpload(fileInput.files[0]);
        });
    }

    function handleFileUpload(file) {
        addLog(`📤 开始读取文件: ${file.name}, 大小: ${(file.size / 1024).toFixed(1)} KB`);
        statusEl.textContent = '读取中...';

        // 检查文件大小
        if (file.size > 5 * 1024 * 1024) { // 5MB
            addLog('⚠️ 文件较大，可能需要较长时间解析');
        }

        const reader = new FileReader();
        reader.onload = function (e) {
            const content = e.target.result;
            addLog(`📦 文件读取完成，内容长度: ${(content.length / 1024).toFixed(1)} KB`);
            statusEl.textContent = '解析中...';
            processFileContent(content, file.name);
        };
        reader.onerror = function () {
            addLog('❌ 文件读取失败');
            statusEl.textContent = '读取失败';
            statusEl.className = 'status-badge status-disconnected';
        };
        // 为大型文件设置超时
        const timeoutId = setTimeout(() => {
            reader.abort();
            addLog('❌ 文件读取超时');
            statusEl.textContent = '读取超时';
            statusEl.className = 'status-badge status-disconnected';
        }, 30000); // 30秒超时

        reader.onloadend = function () {
            clearTimeout(timeoutId);
        };

        reader.readAsText(file);
    }

    // 统一的文件处理逻辑
    async function processFileContent(content, fileName) {
        addLog(`📦 文件大小: ${(content.length / 1024).toFixed(1)} KB`);

        // [Context Slicing] Reset selection on new data load
        // Ensure this logic exists to prevent hallucination on stale data
        if (typeof clearContextSelection === 'function') {
            clearContextSelection();
            addLog('🧹 已重置上下文选择状态');
        }

        // 调用解析器
        const result = BaseFileParser.parseBaseFile(content);

        if (result.success) {
            addLog(`✅ 解析成功! ${result.tableCount} 张表, ${result.fieldCount} 个字段`);
            statusEl.textContent = '解析完成';
            statusEl.className = 'status-badge status-connected';

            // 标记已有 base 文件数据
            hasBaseFileData = true;

            // ===== 步骤1: 生成文档 =====
            addLog('📊 生成关联关系图...');
            const relationshipMd = RelationshipParser.generate(
                result.rawData.allTables,
                result.rawData.tableMap,
                result.rawData.fieldMap
            );

            addLog('⚙️ 生成自动化地图...');
            const automationResult = AutomationParser.generate(
                result.rawData.gzipAutomation,
                result.rawData.snapshot,
                result.rawData.tableMap,
                result.rawData.fieldMap,
                result.rawData.allTables
            );

            let automationMd = '';
            if (automationResult.success) {
                automationMd = automationResult.automationMd;
                addLog(`✅ 自动化地图: ${automationResult.workflowCount} 个工作流`);
            } else {
                automationMd = `# 自动化地图\n\n> ${automationResult.error || '无自动化数据'}`;
                addLog('⚠️ 无自动化数据或解析失败');
            }

            addLog('🔍 运行完整性校验...');
            const workflows = automationResult.success ?
                AutomationParser.decompressAutomation(result.rawData.gzipAutomation) || [] : [];
            const checkerResult = CompletenessChecker.check(
                workflows,
                result.fieldTableMd,
                relationshipMd,
                automationMd,
                result.rawData.allTables,
                result.rawData.tableMap,
                result.rawData.fieldMap
            );

            if (checkerResult.isComplete) {
                addLog('✅ 完整性校验通过');
            } else {
                addLog(`⚠️ 发现 ${checkerResult.problemCount} 个问题`);
            }

            // 新生成的文档
            const newDocuments = {
                fieldTableMd: result.fieldTableMd,
                relationshipMd: relationshipMd,
                automationMd: automationMd,
                reportMd: checkerResult.report
            };

            // 更新当前运行时数据，确保聊天上下文可用
            window.currentRawData = result.rawData;
            window.currentDocuments = newDocuments;

            // [Context Slicing] 预处理切片数据 (V2: 同步时生成并缓存)
            addLog('🔪 正在预处理上下文切片...');
            const slices = { tables: {}, workflows: {} };

            // A. 生成数据表片段
            result.rawData.allTables.forEach(table => {
                try {
                    const md = BaseFileParser.generateFieldTable(
                        [table],
                        result.rawData.tableMap,
                        result.rawData.fieldMap
                    );
                    if (md) {
                        slices.tables[table.meta.id] = md;
                    } else {
                        console.warn(`Slice table ${table.meta.id} returned empty`);
                    }
                } catch (e) {
                    console.error(`Slice table ${table.meta.id} failed:`, e);
                    addLog(`⚠️ [切片生成失败] 表 "${table.meta.id}": ${e.message}`);
                }
            });

            // B. 生成工作流片段
            try {
                const workflows = AutomationParser.decompressAutomation(result.rawData.gzipAutomation) || [];
                const optionMap = AutomationParser.buildOptionMap(result.rawData.allTables);
                const blockMap = AutomationParser.buildBlockMap(result.rawData.snapshot || []);

                workflows.forEach(wf => {
                    try {
                        const wfLines = AutomationParser.parseWorkflow(
                            wf,
                            result.rawData.tableMap,
                            result.rawData.fieldMap,
                            optionMap,
                            blockMap
                        );
                        // 兼容新版解析器返回的对象格式
                        const linesArray = wfLines.lines ? wfLines.lines : wfLines;
                        slices.workflows[String(wf.id)] = linesArray.join('\n');
                    } catch (e) { console.error(`Slice workflow ${wf.id} failed:`, e); }
                });
            } catch (e) { console.error('Workflow slice preprocessing failed:', e); }

            // [Context Slicing] 立即同步更新到全局内存变量，确保 AI 聊天能用到最新的数据
            window.currentSlices = slices;

            // [Context Slicing] 刷新 UI 上的引用数据选择列表 (确保新增的表能显示在列表中)
            if (typeof initContextSlicing === 'function') {
                initContextSlicing();
            }

            // ===== 步骤2: 版本对比（基于生成的结构化数据） =====
            let changeReport = null;
            try {
                const projectId = await ProjectManager.getActiveProjectId();

                if (projectId) {
                    const previousData = await ProjectManager.getProjectData(projectId);

                    // Fix: rawContent is stored inside the version object
                    const oldContent = previousData?.version?.rawContent;
                    let diffSuccess = false;

                    if (oldContent) {
                        addLog('🔍 检测到历史版本，正在对比变动...');
                        const oldStruct = BaseFileParser.parseBaseFileStruct(oldContent);
                        const newStruct = BaseFileParser.parseBaseFileStruct(content);

                        if (oldStruct.success && newStruct.success) {
                            addLog('📊 分析数据结构变动...');
                            const changes = ChangeDetector.diff(oldStruct, newStruct);
                            changeReport = ChangeDetector.generateMarkdown(changes);

                            const totalChanges = (changes.fields?.length || 0) + (changes.automations?.length || 0);
                            if (totalChanges > 0) {
                                addLog(`📊 发现 ${totalChanges} 处变动!`);
                            } else {
                                addLog('✅ 没有检测到变动 (数据结构一致)');
                            }
                            diffSuccess = true;
                        } else {
                            addLog('⚠️ 解析失败，跳过对比');
                            if (!oldStruct.success) console.error('Old parse error:', oldStruct.error);
                            if (!newStruct.success) console.error('New parse error:', newStruct.error);
                        }
                    }

                    if (!diffSuccess) {
                        if (!previousData) {
                            addLog('📝 首次同步，将作为基线版本保存');
                            changeReport = '# 📊 变动报告\n\n> 🟢 首次同步，已建立基线版本。\n\n当前版本将作为后续对比的基准。';
                        } else {
                            // existing project but no content or parse failed
                            addLog('⚠️ 无法进行有效对比 (无历史源码或解析失败)');
                            changeReport = '# 📊 变动报告\n\n> ⚠️ 无法对比: 历史版本缺少源码或解析失败。';
                        }
                    }

                    // ===== 步骤3: 保存新版本 =====
                    const projectName = result.rawData.allTables?.[0]?.name || fileName || '未命名项目';

                    // Save diff report
                    newDocuments.diffMd = changeReport;

                    // ===== 步骤2: 保存到本地数据库 =====
                    addLog('💾 正在保存到本地档案库...');
                    const { project, version } = await ProjectManager.saveVersion(
                        projectId, // Assuming projectId is the appToken here, based on context
                        projectName, // Assuming projectName is fileName.replace('.base', '')
                        content,
                        newDocuments,
                        result.rawData,
                        slices // 传入生成的切片
                    );
                    addLog('💾 版本已保存到本地档案库');

                } else {
                    addLog('⚠️ 无法识别项目 ID，跳过版本保存');
                    changeReport = '# 📊 变动报告\n\n> ⚠️ 无法识别项目，无法进行版本对比。';
                }
            } catch (e) {
                console.error('Version comparison failed:', e);
                addLog(`⚠️ 版本对比失败: ${e.message}`);
                changeReport = `# 📊 变动报告\n\n> ❌ 版本对比失败: ${e.message}`;
            }

            // ===== 步骤4: 显示结果 =====
            const documents = [
                { id: 'changes', name: '📊 变动报告', content: changeReport },
                { id: 'field-table', name: '全量字段表', content: result.fieldTableMd },
                { id: 'relationships', name: '关联关系图', content: relationshipMd },
                { id: 'automation', name: '自动化地图', content: automationMd },
                { id: 'report', name: '校验报告', content: checkerResult.report }
            ];

            // 保存到本地存储
            saveToStorage({
                fileName: fileName,
                parsedResults: documents,
                fieldTableMd: result.fieldTableMd,
                automationMd: automationMd,
                relationMd: relationshipMd,
                tableMap: result.rawData.tableMap,
                fieldMap: result.rawData.fieldMap,
                timestamp: Date.now()
            });

            renderTabs(documents);

            // 保存到后台
            chrome.runtime.sendMessage({
                action: 'STORE_BASE_DATA',
                payload: result.rawData
            });
        } else {
            addLog(`❌ 解析失败: ${result.error}`);
            statusEl.textContent = '解析失败';
            statusEl.className = 'status-badge status-disconnected';
        }
    }




    /**
     * 显示缓存数据 - 从本地存储加载时使用
     * @param {Object} documents 文档对象 { fieldTableMd, relationshipMd, ... }
     */
    function displayCachedResults(documents) {
        if (!documents) return;

        // 将对象转换为 renderTabs 需要的数组格式
        const docsArray = [];

        // 1. 变动报告
        if (documents.diffMd) {
            docsArray.push({ id: 'changes', name: '📊 变动报告', content: documents.diffMd });
        } else if (documents.changeReport) {
            docsArray.push({ id: 'changes', name: '📊 变动报告', content: documents.changeReport });
        }

        // 2. 核心文档
        // (保持顺序：字段表 -> 自动化 -> 关系图)

        if (documents.fieldTableMd) {
            docsArray.push({ id: 'field_table', name: '全量字段表', content: documents.fieldTableMd });
        }

        if (documents.automationMd) {
            docsArray.push({ id: 'automation_map', name: '自动化地图', content: documents.automationMd });
        }

        if (documents.relationshipMd) {
            docsArray.push({ id: 'relation_graph', name: '关联关系图', content: documents.relationshipMd });
        }

        // 3. 完整性校验报告 (兼容旧数据 reportMd) / 隐藏校验报告，保留数据在后台供AI使用
        // if (documents.reportMd) {
        //     docsArray.push({ id: 'report', name: '✅ 校验报告', content: documents.reportMd });
        // } else if (documents.completenessReport) {
        //     docsArray.push({ id: 'report', name: '✅ 校验报告', content: documents.completenessReport });
        // }

        if (docsArray.length > 0) {
            renderTabs(docsArray);
        }
    }

    /**
     * 渲染标签页
     */
    function renderTabs(documents) {
        const previewEl = document.getElementById('markdown-preview');
        if (!previewEl) return;

        if (!Array.isArray(documents)) {
            console.error('renderTabs expected an array, got:', documents);
            return;
        }

        // 清空预览区域
        previewEl.innerHTML = '';

        // 创建标签栏
        const tabBar = document.createElement('div');
        tabBar.className = 'tab-bar';

        // 创建下拉目录容器
        const tocContainer = document.createElement('div');
        tocContainer.className = 'toc-select-container';
        tocContainer.style.display = 'none';
        tocContainer.style.padding = '8px 10px';
        tocContainer.style.background = '#f8f9fa';
        tocContainer.style.borderBottom = '1px solid #eee';

        const tocSelect = document.createElement('select');
        tocSelect.className = 'toc-select';
        tocSelect.style.width = '100%';
        tocSelect.style.padding = '6px';
        tocSelect.style.borderRadius = '4px';
        tocSelect.style.border = '1px solid #ccc';
        tocSelect.style.outline = 'none';
        tocContainer.appendChild(tocSelect);

        // 创建内容区域
        const contentArea = document.createElement('div');
        contentArea.className = 'tab-content';

        function updateTocAndScroll() {
            tocSelect.innerHTML = '';
            const headers = Array.from(contentArea.querySelectorAll('h2, h3'));
            const validHeaders = headers.filter(h => h.textContent.trim() !== '' && !h.textContent.includes('目录'));

            if (validHeaders.length === 0) {
                tocContainer.style.display = 'none';
                return;
            }

            tocContainer.style.display = 'block';
            let currentOptGroup = null;

            validHeaders.forEach((header, i) => {
                if (!header.id) {
                    header.id = 'toc-header-' + i;
                }

                const tagName = header.tagName.toLowerCase();
                const text = header.textContent.replace(/^#+\s*/, '').trim();

                // 识别分类节点 (处理自动化地图中的 "已启用"/"已禁用" h3 分类)
                if (tagName === 'h3' && (text.includes('已启用') || text.includes('已禁用'))) {
                    currentOptGroup = document.createElement('optgroup');
                    currentOptGroup.label = text;
                    tocSelect.appendChild(currentOptGroup);
                    return; // 分类节点本身不作为可跳转选项
                }

                const option = document.createElement('option');
                option.value = header.id;

                // 普通 h3 加缩进前缀
                const prefix = (tagName === 'h3' && !currentOptGroup) ? '　├ ' : '';
                option.textContent = prefix + text;

                if (currentOptGroup) {
                    currentOptGroup.appendChild(option);
                } else {
                    tocSelect.appendChild(option);
                }
            });
        }

        tocSelect.addEventListener('change', (e) => {
            const targetId = e.target.value;
            const targetEl = contentArea.querySelector(`[id="${targetId}"]`);
            if (targetEl) {
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });

        let isScrolling = false;
        contentArea.addEventListener('scroll', () => {
            if (isScrolling) return;
            window.requestAnimationFrame(() => {
                const headers = Array.from(contentArea.querySelectorAll('h2, h3'));
                if (headers.length === 0) {
                    isScrolling = false;
                    return;
                }

                const containerTop = contentArea.getBoundingClientRect().top;
                let currentId = headers[0].id;

                for (const header of headers) {
                    const rect = header.getBoundingClientRect();
                    if (rect.top - containerTop <= 50) {
                        currentId = header.id;
                    } else {
                        break;
                    }
                }

                if (currentId && tocSelect.value !== currentId) {
                    tocSelect.value = currentId;
                }
                isScrolling = false;
            });
            isScrolling = true;
        });

        documents.forEach((doc, index) => {
            const tab = document.createElement('button');
            tab.textContent = doc.name;
            tab.className = `tab-btn ${index === 0 ? 'active' : ''}`;

            tab.addEventListener('click', () => {
                // 切换高亮
                Array.from(tabBar.children).forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // 切换内容，并使用 marked.parse 将 Markdown 渲染为 HTML
                if (typeof marked !== 'undefined') {
                    contentArea.innerHTML = marked.parse(doc.content);
                    updateTocAndScroll();
                } else {
                    contentArea.textContent = doc.content;
                    tocContainer.style.display = 'none';
                }
                // 重置滚动位置
                contentArea.scrollTop = 0;
            });

            tabBar.appendChild(tab);
        });

        // 增加侧边栏平滑滚动事件拦截处理 (针对内部原生锚点)
        contentArea.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (link) {
                const href = link.getAttribute('href');
                if (href && href.startsWith('#')) {
                    e.preventDefault();
                    const targetId = href.substring(1);
                    const targetEl = contentArea.querySelector(`[id="${targetId}"], [name="${targetId}"]`);
                    if (targetEl) {
                        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }
            }
        });

        // 默认显示第一个
        if (documents.length > 0) {
            if (typeof marked !== 'undefined') {
                contentArea.innerHTML = marked.parse(documents[0].content);
                updateTocAndScroll();
            } else {
                contentArea.textContent = documents[0].content;
                tocContainer.style.display = 'none';
            }
        } else {
            contentArea.textContent = "无数据";
            tocContainer.style.display = 'none';
        }

        previewEl.appendChild(tabBar);
        previewEl.appendChild(tocContainer);
        previewEl.appendChild(contentArea);

        // 确保容器显示
        const previewCard = document.getElementById('preview-card-container');
        if (previewCard) previewCard.style.display = 'flex';
    }

    /**
     * 刷新文档标签页显示（从存储重新加载）
     */
    function refreshDocumentsTab() {
        chrome.storage.local.get(['feishu_parsed_data'], (result) => {
            if (result.feishu_parsed_data) {
                const data = result.feishu_parsed_data;
                // 如果有 parsedResults 数组格式，直接使用
                if (data.parsedResults && Array.isArray(data.parsedResults)) {
                    renderTabs(data.parsedResults);
                    addLog('🔄 文档显示已刷新');
                }
            }
        });
    }

    // ========== 主标签页切换 ==========
    window.switchMainTab = function (tabId) {
        document.querySelectorAll('.main-tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabId);
        });
        document.querySelectorAll('.main-tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `tab-${tabId}`);
        });

        // 切换到 Chat 标签时初始化
        if (tabId === 'chat') {
            initChat();
        } else if (tabId === 'settings') {
            initSettings();
        }
    };

    async function initSettings() {
        const provider = await AIApi.getProvider();
        const apiKey = await AIApi.getApiKey();
        const model = await AIApi.getModel();
        const endpoint = await AIApi.getEndpoint();

        // 绑定/更新 UI
        const providerSelect = document.getElementById('settings-provider');
        const apiKeyInput = document.getElementById('settings-api-key');
        const endpointInput = document.getElementById('settings-endpoint');
        const modelSelect = document.getElementById('settings-model');
        const promptInput = document.getElementById('settings-system-prompt');

        if (providerSelect) providerSelect.value = provider;
        if (apiKeyInput) apiKeyInput.value = apiKey || '';
        if (endpointInput) endpointInput.value = endpoint || '';

        // 加载模型列表
        await refreshModelListUI();
        if (modelSelect) modelSelect.value = model;

        // 加载系统提示词
        if (promptInput) {
            let template = await AIApi.getSystemPromptTemplate();
            // [Migration] 检查是否为旧版 Prompt
            if (template && (template.includes('```json') || template.includes('"updates"'))) {
                template = AIApi.DEFAULT_SYSTEM_TEMPLATE;
                await AIApi.setSystemPromptTemplate(template);
                addLog('♻️ 已自动升级系统提示词模板');
            }
            promptInput.value = template;
        }

        // 绑定恢复默认按钮 (确保只绑定一次)
        const resetBtn = document.getElementById('settings-reset-prompt-btn');
        if (resetBtn && !resetBtn.dataset.bound) {
            resetBtn.addEventListener('click', async () => {
                if (confirm('确定要恢复默认的系统提示词吗？这将覆盖当前设置并自动保存。')) {
                    const defaultTemplate = AIApi.DEFAULT_SYSTEM_TEMPLATE;
                    if (promptInput) promptInput.value = defaultTemplate;
                    try {
                        await AIApi.setSystemPromptTemplate(defaultTemplate);
                        addLog('✅ 系统提示词已恢复默认并保存');
                        const statusEl = document.getElementById('settings-status');
                        if (statusEl) {
                            statusEl.textContent = '✅ 已恢复默认配置';
                            statusEl.className = 'chat-settings-status success';
                        }
                    } catch (e) {
                        alert('保存失败: ' + e.message);
                    }
                }
            });
            resetBtn.dataset.bound = 'true';
        }
    }

    /**
     * 更新模型下拉列表
     */
    async function refreshModelListUI() {
        const modelSelect = document.getElementById('settings-model');
        if (!modelSelect) return;

        const models = await AIApi.getAvailableModels();
        const currentModel = await AIApi.getModel();

        modelSelect.innerHTML = '';

        // 如果没有模型，添加默认或提示
        if (models.length === 0) {
            const provider = await AIApi.getProvider();
            if (provider === 'openai') {
                const opt1 = new Option('gpt-4o (OpenAI 👁️)', 'gpt-4o');
                const opt2 = new Option('gpt-4o-mini (OpenAI 👁️)', 'gpt-4o-mini');
                modelSelect.add(opt1);
                modelSelect.add(opt2);
            } else {
                modelSelect.add(new Option('请点击右侧按钮拉取模型列表', ''));
            }
        } else {
            models.forEach(m => {
                const text = `${m.name || m.id}${m.vision ? ' 👁️' : ''}`;
                const option = new Option(text, m.id);
                modelSelect.add(option);
            });
        }

        // 恢复选中
        if (currentModel) modelSelect.value = currentModel;
    }

    document.querySelectorAll('.main-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            switchMainTab(btn.dataset.tab);
        });
    });

    // ========== Chat 功能 ==========
    // let chatInitialized = false; // Moved to top
    let pendingImage = null;

    async function initChat() {
        if (chatInitialized) return;

        // 检查是否有 API Key
        const apiKey = await AIApi.getApiKey();
        const setupRequired = document.getElementById('chat-setup-required');
        const chatMain = document.getElementById('chat-main');

        if (!apiKey) {
            setupRequired.style.display = 'flex';
            chatMain.style.display = 'none';
            return;
        }

        // 先显示界面，再初始化（避免白屏）
        setupRequired.style.display = 'none';
        chatMain.style.display = 'flex';

        try {
            // 初始化会话
            await AIChat.init();

            // 默认不选中任何历史会话，显示新建页面
            AIChat.currentSessionId = null;

            // 更新 UI
            updateChatUI();
        } catch (e) {
            console.error('Chat init error:', e);
            addLog(`❌ Chat 初始化失败: ${e.message}`);
        }

        chatInitialized = true;
    }

    function updateChatUI() {
        renderSessionList();

        const session = AIChat.getCurrentSession();
        if (!session) {
            // 新对话状态
            document.getElementById('chat-current-title').textContent = '新对话';
            renderMessages([]); // 显示空空如也的欢迎页
            // 确保侧边栏高亮移除
            document.querySelectorAll('.chat-session-item.active').forEach(el => el.classList.remove('active'));
            return;
        }

        // 更新标题
        document.getElementById('chat-current-title').textContent = session.title;

        // 更新消息列表
        renderMessages(session.messages);
    }

    function renderMessages(messages) {
        const container = document.getElementById('chat-messages');
        container.innerHTML = '';

        if (messages.length === 0) {
            container.innerHTML = `
                <div class="chat-empty">
                    <div class="chat-empty-icon">💬</div>
                    <div class="chat-empty-text">
                        发送消息开始对话<br>
                        AI 会根据你的文档回答问题
                    </div>
                </div>
            `;
            return;
        }

        messages.forEach((msg, index) => {
            const msgEl = document.createElement('div');
            msgEl.className = `chat-message ${msg.role}`;

            // 消息内容
            // 消息内容
            let content;
            if (typeof marked !== 'undefined' && msg.role === 'assistant') {
                content = marked.parse(msg.content);
            } else {
                content = escapeHtml(msg.content);
                // 简单的 Markdown 处理
                content = content.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
                content = content.replace(/`([^`]+)`/g, '<code>$1</code>');
                content = content.replace(/\n/g, '<br>');
            }

            msgEl.innerHTML = content;

            // 如果有图片
            if (msg.image) {
                const img = document.createElement('img');
                img.src = `data:image/png;base64,${msg.image}`;
                img.className = 'chat-message-image';
                msgEl.appendChild(img);
            }

            // 如果有更新操作
            if (msg.updates && msg.updates.length > 0) {
                const actionsEl = document.createElement('div');
                actionsEl.className = 'chat-update-actions';

                msg.updates.forEach((update, i) => {
                    const btn = document.createElement('button');
                    btn.className = 'chat-apply-btn';

                    // 检查是否已应用
                    if (update.applied) {
                        btn.textContent = '✅ 已应用';
                        btn.classList.add('applied');
                        btn.disabled = true;
                    } else {
                        btn.innerHTML = `📝 应用到「${getDocName(update.doc)}」`;
                    }

                    btn.onclick = async () => {
                        btn.disabled = true;
                        btn.textContent = '应用中...';
                        const result = await AIChat.applyUpdates([update]);
                        if (result.success) {
                            btn.textContent = '✅ 已应用';
                            btn.classList.add('applied');
                            addLog('✅ 文档已更新');
                            // 刷新文档标签页显示
                            refreshDocumentsTab();
                        } else {
                            btn.textContent = '❌ 失败';
                            btn.disabled = false;
                        }
                    };
                    actionsEl.appendChild(btn);
                });

                msgEl.appendChild(actionsEl);
            }

            container.appendChild(msgEl);
        });

        // 滚动到底部
        container.scrollTop = container.scrollHeight;
    }

    function getDocName(docId) {
        const names = {
            'field_table': '全量字段表',
            '全量字段表': '全量字段表',
            'automation_map': '自动化地图',
            '自动化地图': '自动化地图',
            'relation_graph': '关联关系图',
            '关联关系图': '关联关系图'
        };
        return names[docId] || docId;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function renderSessionList() {
        const list = document.getElementById('chat-session-list');
        list.innerHTML = '';

        AIChat.sessions.forEach(session => {
            const item = document.createElement('div');
            item.className = `chat-session-item ${session.id === AIChat.currentSessionId ? 'active' : ''}`;
            item.innerHTML = `
                <div class="chat-session-item-title">${escapeHtml(session.title)}</div>
                <div class="chat-session-item-date">${new Date(session.createdAt).toLocaleDateString()}</div>
            `;
            item.onclick = () => {
                AIChat.switchSession(session.id);
                updateChatUI();
                closeSidebar();
            };
            list.appendChild(item);
        });
    }

    function closeSidebar() {
        document.getElementById('chat-sidebar').classList.remove('open');
        document.getElementById('chat-sidebar-overlay')?.classList.remove('open');
    }

    // Chat 事件绑定
    document.getElementById('chat-menu-btn')?.addEventListener('click', () => {
        const sidebar = document.getElementById('chat-sidebar');
        const overlay = document.getElementById('chat-sidebar-overlay');
        sidebar.classList.toggle('open');
        overlay.classList.toggle('open');
    });

    // 关闭按钮
    document.getElementById('chat-sidebar-close-btn')?.addEventListener('click', closeSidebar);

    // 点击遮罩关闭
    document.getElementById('chat-sidebar-overlay')?.addEventListener('click', closeSidebar);

    function closeSidebarWithOverlay() {
        document.getElementById('chat-sidebar').classList.remove('open');
        document.getElementById('chat-sidebar-overlay').classList.remove('open');
    }

    document.getElementById('chat-new-btn')?.addEventListener('click', async () => {
        // 仅重置当前会话 ID，不立即创建会话
        AIChat.currentSessionId = null;
        updateChatUI();
        closeSidebar();
    });

    document.getElementById('chat-new-inline-btn')?.addEventListener('click', async () => {
        AIChat.currentSessionId = null;
        updateChatUI();
    });

    // 发送消息
    document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);
    document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });

    // 输入框自动拓高 (最高 200px)
    document.getElementById('chat-input')?.addEventListener('input', function () {
        this.style.height = 'auto';
        const newHeight = Math.min(this.scrollHeight, 200);
        this.style.height = newHeight + 'px';
    });

    async function sendChatMessage() {
        const input = document.getElementById('chat-input');
        const content = input.value.trim();
        if (!content) return;

        const sendBtn = document.getElementById('chat-send-btn');
        sendBtn.disabled = true;
        sendBtn.textContent = '发送中...';
        input.value = '';
        input.style.height = 'auto'; // 发送后重置高度

        // 如果当前没有会话（新对话状态），自动创建
        let session = AIChat.getCurrentSession();
        if (!session) {
            session = await AIChat.createSession();
            // 更新 UI 以显示新会话侧边栏项
            updateChatUI();
        }

        const userMsg = { role: 'user', content, image: pendingImage };
        session.messages.push(userMsg);
        renderMessages(session.messages);

        // 清除图片预览
        clearImagePreview();

        // 添加加载指示器
        const messagesEl = document.getElementById('chat-messages');
        const loadingEl = document.createElement('div');
        loadingEl.className = 'chat-loading';
        loadingEl.innerHTML = `
            <div class="chat-loading-dots">
                <div class="chat-loading-dot"></div>
                <div class="chat-loading-dot"></div>
                <div class="chat-loading-dot"></div>
            </div>
            <span>AI 思考中...</span>
        `;
        messagesEl.appendChild(loadingEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;

        try {
            // 移除临时添加的消息（因为 sendMessage 会重新添加）
            session.messages.pop();

            // [Context Slicing] 准备上下文
            let customContext = null;

            // ===== [调试日志] 记录发送前的全局状态 =====
            const slicesKeys = window.currentSlices ? {
                tables: Object.keys(window.currentSlices.tables || {}),
                workflows: Object.keys(window.currentSlices.workflows || {})
            } : null;
            const selectionState = window.contextSelection ? {
                tableIds: Array.from(window.contextSelection.tableIds || []),
                workflowIds: Array.from(window.contextSelection.workflowIds || []),
                isAllTables: window.contextSelection.isAllTables,
                isAllWorkflows: window.contextSelection.isAllWorkflows,
                includeFullFieldTable: window.contextSelection.includeFullFieldTable,
                includeFullRelationGraph: window.contextSelection.includeFullRelationGraph,
                includeFullAutomationMap: window.contextSelection.includeFullAutomationMap
            } : null;

            addLog(`🔍 [调试] 切片缓存: ${slicesKeys ? slicesKeys.tables.length + '个表, ' + slicesKeys.workflows.length + '个工作流' : '无数据'}`);
            addLog(`🔍 [调试] 选中状态: ${selectionState ? selectionState.tableIds.length + '个表, ' + selectionState.workflowIds.length + '个工作流' : '未初始化'}`);
            console.log('[Debug] window.currentSlices keys:', slicesKeys);
            console.log('[Debug] window.contextSelection:', selectionState);
            console.log('[Debug] window.currentRawData:', window.currentRawData ? '存在' : '不存在');
            console.log('[Debug] window.currentDocuments:', window.currentDocuments ? '存在' : '不存在');

            // 总是生成切片上下文 (因为 ai-chat 默认不加载全量，必须由这里传入)
            if (window.contextSelection && window.currentRawData) {
                addLog('🔪 正在生成切片上下文...');
                try {
                    customContext = generateSlicedContext();

                    // ===== [调试日志] 记录生成结果 =====
                    const ctxFieldLen = customContext?.fieldTable?.length || 0;
                    const ctxAutoLen = customContext?.automationMap?.length || 0;
                    const ctxRelLen = customContext?.relationGraph?.length || 0;
                    addLog(`📊 [调试] 生成结果: 字段表=${ctxFieldLen}字符, 自动化=${ctxAutoLen}字符, 关联图=${ctxRelLen}字符`);
                    console.log('[Debug] customContext lengths:', { fieldTable: ctxFieldLen, automationMap: ctxAutoLen, relationGraph: ctxRelLen });

                    // 如果所有内容都为空，发出警告
                    if (ctxFieldLen === 0 && ctxAutoLen === 0 && ctxRelLen === 0) {
                        addLog('⚠️ [调试] 警告：所有切片内容都为空！请检查选择状态和切片数据是否匹配');
                        console.warn('[Debug] All context slices are EMPTY! Selection vs Slices mismatch?');
                        console.warn('[Debug] Selected table IDs:', selectionState?.tableIds);
                        console.warn('[Debug] Available slice table IDs:', slicesKeys?.tables);
                    }
                } catch (e) {
                    console.error('Slice generation failed:', e);
                    addLog('⚠️ 上下文切片生成异常，已自动降级为使用全量数据');
                    // 降级策略：从全局变量中尝试恢复全量文档
                    if (window.currentDocuments) {
                        customContext = {
                            fieldTable: window.currentDocuments.fieldTableMd || "",
                            automationMap: window.currentDocuments.automationMd || "",
                            relationGraph: window.currentDocuments.relationshipMd || ""
                        };
                    }
                }
            } else {
                // ===== [调试日志] 记录为什么没有生成切片 =====
                addLog(`⚠️ [调试] 未生成切片! contextSelection=${!!window.contextSelection}, currentRawData=${!!window.currentRawData}`);
            }

            const response = await AIChat.sendMessage(content, pendingImage, customContext);
            pendingImage = null;

            loadingEl.remove();
            updateChatUI();

        } catch (error) {
            loadingEl.remove();

            // 添加错误消息
            const errorMsg = document.createElement('div');
            errorMsg.className = 'chat-message assistant error';
            errorMsg.textContent = `错误: ${error.message}`;
            messagesEl.appendChild(errorMsg);

            addLog(`❌ Chat 错误: ${error.message}`);
        }

        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
    }

    // 图片上传
    document.getElementById('chat-image-btn')?.addEventListener('click', () => {
        document.getElementById('chat-image-input').click();
    });

    document.getElementById('chat-image-input')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const base64 = e.target.result.split(',')[1];
            pendingImage = base64;

            document.getElementById('chat-preview-img').src = e.target.result;
            document.getElementById('chat-image-preview').style.display = 'flex';
        };
        reader.readAsDataURL(file);
    });

    document.getElementById('chat-remove-image')?.addEventListener('click', clearImagePreview);

    function clearImagePreview() {
        pendingImage = null;
        document.getElementById('chat-image-preview').style.display = 'none';
        document.getElementById('chat-image-input').value = '';
    }

    // ========== 设置功能 ==========

    // Provider 切换
    document.getElementById('settings-provider')?.addEventListener('change', async (e) => {
        const newProvider = e.target.value;
        await AIApi.setProvider(newProvider);
        // 重新加载该提供商的配置
        await initSettings();
    });

    // 刷新模型列表
    document.getElementById('settings-refresh-models-btn')?.addEventListener('click', async () => {
        const apiKey = document.getElementById('settings-api-key').value.trim();
        const endpoint = document.getElementById('settings-endpoint').value.trim();
        const btn = document.getElementById('settings-refresh-models-btn');
        const statusEl = document.getElementById('settings-status');

        if (!apiKey) {
            statusEl.textContent = '❌ 请先输入 API Key';
            statusEl.className = 'chat-settings-status error';
            return;
        }

        const originalHtml = btn.innerHTML;
        btn.innerHTML = '⌛';
        btn.disabled = true;

        try {
            statusEl.textContent = '正在保存配置并获取模型...';
            statusEl.className = 'chat-settings-status';

            // 自动保存当前输入的 Key 和 Endpoint
            await AIApi.setApiKey(apiKey);
            await AIApi.setEndpoint(endpoint);

            const models = await AIApi.fetchAvailableModels();
            console.log(`[Sidepanel] Fetched ${models.length} models for current provider`);

            await refreshModelListUI();

            statusEl.textContent = `✅ 配置已保存并成功获取 ${models.length} 个模型`;
            statusEl.className = 'chat-settings-status success';

            // 标记已更新
            chatInitialized = false;
        } catch (e) {
            console.error('[Sidepanel] Model refresh failed:', e);
            statusEl.textContent = `❌ 获取失败: ${e.message}`;
            statusEl.className = 'chat-settings-status error';
        } finally {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    });

    document.getElementById('settings-save-btn')?.addEventListener('click', async () => {
        const apiKey = document.getElementById('settings-api-key').value.trim();
        const model = document.getElementById('settings-model').value;
        const endpoint = document.getElementById('settings-endpoint').value.trim();
        const systemPrompt = document.getElementById('settings-system-prompt').value;

        // 这里不强制要求 API Key，因为可能用户只是换了提供商但还没填 Key
        // 但保存时我们会把当前 UI 的值存给当前 Provider
        await AIApi.setApiKey(apiKey);
        await AIApi.setModel(model);
        await AIApi.setEndpoint(endpoint);
        await AIApi.setSystemPromptTemplate(systemPrompt);

        document.getElementById('settings-status').textContent = '✅ 配置已保存';
        document.getElementById('settings-status').className = 'chat-settings-status success';

        chatInitialized = false;
        addLog('⚙️ AI 配置已更新');
    });

    document.getElementById('settings-test-btn')?.addEventListener('click', async () => {
        const apiKey = document.getElementById('settings-api-key').value.trim();
        const statusEl = document.getElementById('settings-status');

        statusEl.textContent = '测试中...';
        statusEl.className = 'chat-settings-status';

        const result = await AIApi.testApiKey(apiKey);

        if (result.valid) {
            statusEl.textContent = '✅ 连接成功！';
            statusEl.className = 'chat-settings-status success';
        } else {
            statusEl.textContent = `❌ ${result.error}`;
            statusEl.className = 'chat-settings-status error';
        }
    });

    document.getElementById('settings-clear-docs')?.addEventListener('click', async () => {
        const projectId = lastProjectId;
        if (!projectId) {
            alert('当前未连接到任何项目，无法清空数据');
            return;
        }

        if (confirm('确定要清空当前项目的文档数据吗？（不影响对话记录）')) {
            try {
                await DB.clearProjectDocs(projectId);
                hasBaseFileData = false;

                // 清空内存显示
                const docContainer = document.getElementById('markdown-preview');
                if (docContainer) docContainer.textContent = '数据已清空，请重新同步';

                // 重新刷新以重置状态
                // location.reload(); // 不需要全部重刷，只要 initProject 重置即可
                // 但为了保险起见，或者更彻底的 UI 重置，可以重刷 initProject
                await initProject();

                addLog('🗑️ 文档数据已清空');
            } catch (e) {
                console.error(e);
                alert('清空失败: ' + e.message);
            }
        }
    });

    document.getElementById('settings-clear-chat')?.addEventListener('click', async () => {
        if (confirm('确定要清空所有对话记录吗？')) {
            await AIChat.clearAllSessions();
            chatInitialized = false;
            addLog('🗑️ 对话记录已清空');
        }
    });

    document.getElementById('settings-clear-all')?.addEventListener('click', async () => {
        if (confirm('确定要清空所有数据吗？这将删除所有解析的文档、历史记录和配置。')) {
            try {
                await DB.clearAll();
                localStorage.clear();
                await chrome.storage.local.clear();
                addLog('✅ 所有数据已清空');
                location.reload();
            } catch (e) {
                console.error(e);
                alert('清空失败: ' + e.message);
            }
        }
    });

    // 初始化时加载设置
    initSettings();

    // [Context Slicing] 绑定事件 (独立于数据加载)
    bindContextSlicingEvents();





    // ========== Context Slicing Logic (Chat Integration) ==========
    // 状态管理
    window.currentSlices = { tables: {}, workflows: {} }; // 存储预生成的片段
    window.currentDocuments = { fieldTableMd: '', relationshipMd: '', automationMd: '' }; // 存储完整 Markdown
    window.contextSelection = {
        tableIds: new Set(),     // 选中的表 ID (默认不选)
        workflowIds: new Set(),  // 选中的工作流 ID (默认不选)
        isAllTables: false,      // 是否全选表 (默认不选)
        isAllWorkflows: false,   // 是否全选工作流 (默认不选)
        // 新增全局文档标志
        includeFullFieldTable: false,
        includeFullRelationGraph: false,
        includeFullAutomationMap: false
    };

    /**
     * 初始化上下文切片功能
     * 安全地从 window.currentRawData 加载数据并渲染
     */
    function initContextSlicing() {
        const rawData = window.currentRawData;
        if (!rawData) {
            updateContextStatusUI(); // 初始化状态栏
            return;
        }

        // 1. 渲染列表
        renderContextSelector(rawData);

        // 初始化默认全选状态 (V2: 默认 None，不需要填充 Set)

        updateContextStatusUI();
        updateSelectionSummary();
    }

    /**
     * 绑定上下文切片相关的 DOM 事件
     */
    /**
     * 绑定上下文切片相关的 DOM 事件
     */
    function bindContextSlicingEvents() {
        // 更新按钮名称引用
        const contextBtn = document.getElementById('chat-context-btn'); // 引用数据按钮

        if (contextBtn && !contextBtn.dataset.bound) {

            // 打开抽屉
            contextBtn.addEventListener('click', () => {
                const drawer = document.getElementById('reference-menu-drawer');
                const overlay = document.getElementById('reference-drawer-overlay');

                if (!drawer || !overlay) {
                    console.error('[Reference Data] Drawer elements not found');
                    return;
                }

                drawer.classList.add('open');
                overlay.classList.add('active');

                // 如果此时没有数据，尝试重新初始化
                const tableList = document.getElementById('ctx-tables-list');
                if (tableList && !tableList.hasChildNodes() && window.currentRawData) {
                    addLog('🔄 正在恢复列表数据...');
                    renderContextSelector(window.currentRawData);
                }
            });
            contextBtn.dataset.bound = 'true';

            // 关闭抽屉 (Close Icon, Overlay, Confirm Button)
            const closeDrawer = () => {
                const drawer = document.getElementById('reference-menu-drawer');
                const overlay = document.getElementById('reference-drawer-overlay');
                if (drawer) drawer.classList.remove('open');
                if (overlay) overlay.classList.remove('active');
            };

            const closeBtn = document.getElementById('reference-drawer-close');
            const overlay = document.getElementById('reference-drawer-overlay');
            const confirmBtn = document.getElementById('reference-drawer-confirm');

            if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
            if (overlay) overlay.addEventListener('click', closeDrawer);
            if (confirmBtn) {
                confirmBtn.addEventListener('click', () => {
                    updateContextStatusUI();
                    closeDrawer();
                    addLog('✅ 引用数据选择已更新');
                });
            }

            // 全选/清空 - 表
            document.getElementById('ctx-tables-all')?.addEventListener('click', () => {
                const checkboxes = document.querySelectorAll('#ctx-tables-list input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    cb.checked = true;
                    window.contextSelection.tableIds.add(cb.value);
                });
                window.contextSelection.isAllTables = true;
                updateSelectionSummary();
                updateContextStatusUI(); // 即时生效
            });
            document.getElementById('ctx-tables-none')?.addEventListener('click', () => {
                const checkboxes = document.querySelectorAll('#ctx-tables-list input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    cb.checked = false;
                    window.contextSelection.tableIds.delete(cb.value);
                });
                window.contextSelection.isAllTables = false;
                updateSelectionSummary();
                updateContextStatusUI(); // 即时生效
            });

            // 全选/清空 - 工作流
            document.getElementById('ctx-workflows-all')?.addEventListener('click', () => {
                const checkboxes = document.querySelectorAll('#ctx-workflows-list input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    cb.checked = true;
                    window.contextSelection.workflowIds.add(cb.value);
                });
                window.contextSelection.isAllWorkflows = true;
                updateSelectionSummary();
                updateContextStatusUI(); // 即时生效
            });
            document.getElementById('ctx-workflows-none')?.addEventListener('click', () => {
                const checkboxes = document.querySelectorAll('#ctx-workflows-list input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    cb.checked = false;
                    window.contextSelection.workflowIds.delete(cb.value);
                });
                window.contextSelection.isAllWorkflows = false;
                updateSelectionSummary();
                updateContextStatusUI(); // 即时生效
            });


        }
    }
    /**
     * 渲染选择列表
     */
    function renderContextSelector(rawData) {
        if (!rawData) return;

        // 0. Global Documents (New)
        const docListEl = document.getElementById('ctx-docs-list');
        if (docListEl) {
            docListEl.innerHTML = '';
            const globalDocs = [
                { id: 'full-field-table', name: '全量字段表', flag: 'includeFullFieldTable' },
                { id: 'full-relation-graph', name: '关联关系图', flag: 'includeFullRelationGraph' },
                { id: 'full-automation-map', name: '自动化地图', flag: 'includeFullAutomationMap' }
            ];

            globalDocs.forEach(doc => {
                const isChecked = window.contextSelection[doc.flag];
                const div = document.createElement('div');
                div.className = 'reference-item';
                div.style.cursor = 'pointer';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = `ctx-doc-${doc.id}`;
                checkbox.checked = isChecked;

                checkbox.addEventListener('click', (e) => e.stopPropagation());
                checkbox.addEventListener('change', (e) => {
                    window.contextSelection[doc.flag] = e.target.checked;
                    updateSelectionSummary();
                    updateContextStatusUI(); // 即时生效
                });

                const label = document.createElement('span');
                label.textContent = doc.name;
                label.style.flex = '1';

                div.appendChild(checkbox);
                div.appendChild(label);
                div.addEventListener('click', () => {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                });
                docListEl.appendChild(div);
            });
        }

        // 1. Tables
        const tableListEl = document.getElementById('ctx-tables-list');
        if (!tableListEl) return;
        tableListEl.innerHTML = '';

        // 排序
        const sortedTables = (rawData.allTables || []).sort((a, b) => {
            const na = rawData.tableMap[a.meta.id] || '';
            const nb = rawData.tableMap[b.meta.id] || '';
            return na.localeCompare(nb);
        });

        sortedTables.forEach(table => {
            const tid = table.meta.id;
            const name = rawData.tableMap[tid] || '未命名表';
            const isChecked = window.contextSelection.isAllTables || window.contextSelection.tableIds.has(tid);

            const div = document.createElement('div');
            div.className = 'reference-item';
            div.style.cursor = 'pointer';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = tid;
            checkbox.checked = isChecked;

            checkbox.addEventListener('click', (e) => e.stopPropagation());
            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    window.contextSelection.tableIds.add(tid);
                } else {
                    window.contextSelection.tableIds.delete(tid);
                    window.contextSelection.isAllTables = false;
                }
                updateSelectionSummary();
                updateContextStatusUI(); // 即时生效
            });

            const label = document.createElement('span');
            label.textContent = name;
            label.style.flex = '1';

            div.appendChild(checkbox);
            div.appendChild(label);

            div.addEventListener('click', () => {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            });

            tableListEl.appendChild(div);
        });

        // 2. Workflows
        const wfListEl = document.getElementById('ctx-workflows-list');
        if (!wfListEl) return;
        wfListEl.innerHTML = '';

        let workflows = [];
        let blockMap = {};
        try {
            workflows = AutomationParser.decompressAutomation(rawData.gzipAutomation) || [];
            blockMap = AutomationParser.buildBlockMap(rawData.snapshot || []);
        } catch (e) { console.error(e); }

        // 过滤可见工作流 (复用 Parser 逻辑)
        const visibleWorkflows = workflows.filter(wf => {
            const wfId = String(wf.id || '');
            const hasBlockEntry = blockMap[wfId] !== undefined;
            // Check draft title
            const extra = wf.WorkflowExtra || {};
            let draft;
            try { draft = typeof extra.Draft === 'string' ? JSON.parse(extra.Draft) : (extra.Draft || {}); } catch { draft = {}; }
            const hasTitle = draft.title && draft.title.trim() !== '';
            return hasBlockEntry || hasTitle;
        });

        visibleWorkflows.forEach(wf => {
            const wfId = String(wf.id);

            // 获取显示名称
            let title = blockMap[wfId];
            if (!title) {
                const extra = wf.WorkflowExtra || {};
                let draft;
                try { draft = typeof extra.Draft === 'string' ? JSON.parse(extra.Draft) : (extra.Draft || {}); } catch { draft = {}; }
                title = draft.title || '未命名工作流';
            }

            const isChecked = window.contextSelection.isAllWorkflows || window.contextSelection.workflowIds.has(wfId);

            const div = document.createElement('div');
            div.className = 'reference-item';
            div.style.cursor = 'pointer';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = wfId;
            checkbox.checked = isChecked;

            checkbox.addEventListener('click', (e) => e.stopPropagation());
            checkbox.addEventListener('change', (e) => {
                if (e.target.checked) {
                    window.contextSelection.workflowIds.add(wfId);
                } else {
                    window.contextSelection.workflowIds.delete(wfId);
                    window.contextSelection.isAllWorkflows = false;
                }
                updateSelectionSummary();
                updateContextStatusUI(); // 即时生效
            });

            const label = document.createElement('span');
            // 检查工作流状态: status === 1 通常表示启用
            const isEnabled = wf.status === 1;
            const statusSuffix = isEnabled ? "" : " (未启用)";
            label.textContent = title + statusSuffix;
            label.style.flex = '1';

            // 未启用项置灰
            if (!isEnabled) {
                label.style.color = '#A3A3A3';
            }

            div.appendChild(checkbox);
            div.appendChild(label);

            div.addEventListener('click', () => {
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
            });

            wfListEl.appendChild(div);
        });
    }

    function updateSelectionSummary() {
        const tCount = window.contextSelection.tableIds.size;
        const wCount = window.contextSelection.workflowIds.size;
        let dCount = 0;
        if (window.contextSelection.includeFullFieldTable) dCount++;
        if (window.contextSelection.includeFullRelationGraph) dCount++;
        if (window.contextSelection.includeFullAutomationMap) dCount++;

        const el = document.getElementById('ctx-summary-count');
        if (el) el.textContent = `已选: ${tCount} 表, ${wCount} 工作流, ${dCount} 全局文档`;
    }

    /**
     * 清空上下文选择
     */
    function clearContextSelection() {
        window.contextSelection = {
            tableIds: new Set(),
            workflowIds: new Set(),
            isAllTables: false,
            isAllWorkflows: false,
            includeFullFieldTable: false,
            includeFullRelationGraph: false,
            includeFullAutomationMap: false
        };
        updateContextStatusUI();
        updateSelectionSummary();

        // 清空 DOM 状态
        const allCheckboxes = document.querySelectorAll('.reference-drawer-body input[type="checkbox"]');
        allCheckboxes.forEach(cb => cb.checked = false);
    }

    function updateContextStatusUI() {
        const statusText = document.getElementById('chat-context-status-text');
        const statusCount = document.getElementById('chat-context-status-count'); // Now used for names
        if (!statusText) return;

        if (window.contextSelection.isAllTables && window.contextSelection.isAllWorkflows) {
            statusText.textContent = "引用数据: 全量数据 (所有表和工作流)";
            if (statusCount) statusCount.style.display = 'none';
        } else {
            const sel = window.contextSelection;
            const rawData = window.currentRawData;

            statusText.textContent = `引用数据:`;

            if (statusCount) {
                statusCount.style.display = 'inline-flex';
                statusCount.style.flexWrap = 'wrap';
                statusCount.style.gap = '4px';
                statusCount.innerHTML = ''; // 清空

                // 0. 全局文档标签
                if (sel.includeFullFieldTable) {
                    const tag = document.createElement('span');
                    tag.className = 'ctx-status-tag doc';
                    tag.textContent = `📄 全量字段表`;
                    statusCount.appendChild(tag);
                }
                if (sel.includeFullRelationGraph) {
                    const tag = document.createElement('span');
                    tag.className = 'ctx-status-tag doc';
                    tag.textContent = `🔗 关联关系图`;
                    statusCount.appendChild(tag);
                }
                if (sel.includeFullAutomationMap) {
                    const tag = document.createElement('span');
                    tag.className = 'ctx-status-tag doc';
                    tag.textContent = `🗺️ 自动化地图`;
                    statusCount.appendChild(tag);
                }

                // 1. 表名称
                if (sel.tableIds.size > 0 && rawData) {
                    sel.tableIds.forEach(id => {
                        const name = rawData.tableMap[id] || id;
                        const tag = document.createElement('span');
                        tag.className = 'ctx-status-tag';
                        tag.textContent = `📊 ${name}`;
                        statusCount.appendChild(tag);
                    });
                }

                // 2. 工作流名称 (需要从 rawData 解析)
                if (sel.workflowIds.size > 0 && rawData) {
                    try {
                        const workflows = AutomationParser.decompressAutomation(rawData.gzipAutomation) || [];
                        const blockMap = AutomationParser.buildBlockMap(rawData.snapshot || []);

                        sel.workflowIds.forEach(id => {
                            let name = blockMap[id];
                            if (!name) {
                                const wf = workflows.find(w => String(w.id) === id);
                                if (wf) {
                                    const extra = wf.WorkflowExtra || {};
                                    let draft;
                                    try { draft = typeof extra.Draft === 'string' ? JSON.parse(extra.Draft) : (extra.Draft || {}); } catch { draft = {}; }
                                    name = draft.title || '未命名工作流';
                                }
                            }
                            const tag = document.createElement('span');
                            tag.className = 'ctx-status-tag wf';
                            tag.textContent = `⚙️ ${name || id}`;
                            statusCount.appendChild(tag);
                        });
                    } catch (e) { console.error('Failed to get workflow names for UI:', e); }
                }

                if (statusCount.children.length === 0) {
                    statusCount.innerHTML = '<span style="color: #999;">(未选择)</span>';
                }
            }
        }
    }

    /**
     * 生成切片上下文 (Markdown)
     * V2: 直接从 window.currentSlices 读取预生成的片段
     */
    function generateSlicedContext() {
        const slices = window.currentSlices;
        const docs = window.currentDocuments;

        // Ensure contextSelection is initialized
        if (!window.contextSelection) {
            window.contextSelection = {
                tableIds: new Set(),
                workflowIds: new Set(),
                isAllTables: false,
                isAllWorkflows: false,
                includeFullFieldTable: false,
                includeFullRelationGraph: false,
                includeFullAutomationMap: false
            };
        }

        const sel = window.contextSelection;

        if (!slices) throw new Error("切片数据未就绪");

        // 1. 全量字段表处理
        let fieldTableMd = "";
        if (sel.includeFullFieldTable && docs?.fieldTableMd) {
            fieldTableMd = docs.fieldTableMd;
        } else {
            const tableParts = [];
            let missingSlices = 0;

            sel.tableIds.forEach(id => {
                if (slices.tables[id]) {
                    tableParts.push(slices.tables[id]);
                } else {
                    missingSlices++;
                    console.warn(`Selected table slice not found: ${id}`);
                }
            });

            if (missingSlices > 0) {
                addLog(`⚠️ ${missingSlices} 个选中表的切片缺失 (可能是解析失败)`);
            }

            fieldTableMd = tableParts.join('\n\n---\n\n');
        }

        // 2. 自动化地图处理
        let automationMd = "";
        if (sel.includeFullAutomationMap && docs?.automationMd) {
            automationMd = docs.automationMd;
        } else {
            const workflowParts = [];
            let missingSlices = 0;

            sel.workflowIds.forEach(id => {
                if (slices.workflows[id]) {
                    workflowParts.push(slices.workflows[id]);
                } else {
                    missingSlices++;
                    console.warn(`Selected workflow slice not found: ${id}`);
                }
            });

            if (missingSlices > 0) {
                addLog(`⚠️ ${missingSlices} 个选中工作流的切片缺失`);
            }

            if (workflowParts.length > 0) {
                automationMd = "# 自动化地图 (切片)\n\n" + workflowParts.join('\n\n---\n\n');
            }
        }

        // 3. 关联关系图处理
        let relationshipMd = null;
        if (sel.includeFullRelationGraph && docs?.relationshipMd) {
            relationshipMd = docs.relationshipMd;
        }

        return {
            fieldTable: fieldTableMd,
            automationMap: automationMd,
            relationGraph: relationshipMd
        };
    }


});
