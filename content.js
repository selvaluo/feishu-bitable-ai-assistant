// content.js
console.log("FeishuRealtime: Content script loaded.");

// 1. 注入拦截脚本到页面主环境
function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('in-page-script.js');
    script.onload = function () {
        this.remove();
        console.log("FeishuRealtime: In-page script injected.");
    };
    (document.head || document.documentElement).appendChild(script);
}

// 必须重新注入拦截脚本，以便 Hook createObjectURL
injectScript();

// 同步状态标记 - 只有在同步过程中才处理拦截到的 Blob
if (typeof isSyncing === 'undefined') {
    var isSyncing = false;
}

// 2. 监听来自拦截脚本的消息
window.addEventListener('message', function (event) {
    if (event.source !== window) return;

    // 捕获下载的 Blob 数据
    if (event.data.type === 'FEISHU_BLOB_INTERCEPTED') {
        // 只有在同步过程中才处理
        if (!isSyncing) {
            console.log('FeishuRealtime: Ignoring Blob (not syncing)');
            return;
        }

        console.log('FeishuRealtime: Intercepted Blob download, forwarding to plugin...');

        // 显示提示 1: 文件已接收
        showToast('📦 文件已接收，正在解析...', 'success');

        // 显示提示 2: 稍后提示同步完成 (营造处理中的感觉，并确保顺序)
        setTimeout(() => {
            showToast('✅ 数据已捕获，同步完成', 'success');
        }, 1500);

        // 发送给 background/sidepanel
        try {
            chrome.runtime.sendMessage({
                action: 'SYNC_FILE_RECEIVED',
                blobUrl: event.data.blobUrl,
                base64: event.data.data,
                size: event.data.size,
                mimeType: event.data.mimeType,
                timestamp: Date.now()
            });
        } catch (e) {
            console.warn('Failed to forward blob:', e);
        }

        // 同步完成后重置标记并关闭捕获
        isSyncing = false;
        window.postMessage({ type: 'FEISHU_TOGGLE_CAPTURE', enabled: false }, '*');
    }
});

// 3. 监听来自 Sidepanel 的指令
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 响应连接检查
    if (request.action === 'PING') {
        sendResponse({ success: true });
        return true;
    }

    // 获取当前页面标题（表格名称）
    if (request.action === 'GET_TITLE') {
        let title = '';
        // 1. 尝试获取飞书多维表格的精确标题元素
        const titleEl = document.querySelector('.base-solo-suite-title-value') ||
            document.querySelector('.base-title-text');

        if (titleEl) {
            title = titleEl.textContent.trim();
        } else {
            // 2. 兜底：使用 document.title
            title = document.title;
            title = title.replace(/ - 飞书.*/, '').replace(/ - Feishu.*/, '');
        }

        sendResponse({ title: title });
        return true;
    }

    // 监听标题变化 (Real-time sync)
    // 使用 MutationObserver 监听 document.title 和 DOM 元素
    if (!window.hasTitleObserver) {
        window.hasTitleObserver = true; // 防止重复注入

        const notifyTitleChange = () => {
            const titleEl = document.querySelector('.base-solo-suite-title-value') ||
                document.querySelector('.base-title-text');
            let title = titleEl ? titleEl.textContent.trim() : document.title;
            title = title.replace(/ - 飞书.*/, '').replace(/ - Feishu.*/, '');

            if (title) {
                try {
                    chrome.runtime.sendMessage({
                        action: 'TITLE_UPDATED',
                        title: title
                    }).catch(() => { }); // 忽略 Promise 报错
                } catch (e) {
                    // 忽略同步报错 (如 Extension context invalidated)
                }
            }
        };

        // 1. 监听 document.title 变化
        const titleObserver = new MutationObserver(notifyTitleChange);
        const titleTag = document.querySelector('title');
        if (titleTag) {
            titleObserver.observe(titleTag, { childList: true });
        }

        // 2. 监听 body 变化以捕获动态生成的标题元素 (防抖)
        let debounceTimer;
        const bodyObserver = new MutationObserver((mutations) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                // 检查标题元素是否在变动列表中，或者直接简单粗暴检查值
                notifyTitleChange();
            }, 1000);
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    if (request.action === 'TRIGGER_SYNC') {
        console.log('FeishuRealtime: Received SYNC command, starting automation...');

        // 设置同步状态
        isSyncing = true;
        // 开启页面内的 Blob 捕获
        window.postMessage({ type: 'FEISHU_TOGGLE_CAPTURE', enabled: true }, '*');

        // 异步执行自动化，立即返回响应
        triggerAutoDownload()
            .then(result => {
                console.log('FeishuRealtime: Auto-download result:', result);
                // 如果下载失败，重置同步状态并关闭捕获
                if (!result.success) {
                    isSyncing = false;
                    window.postMessage({ type: 'FEISHU_TOGGLE_CAPTURE', enabled: false }, '*');
                }
                // 如果成功，捕获会在接收到 Blob 后由 message listener 关闭 (见下方修改)
            })
            .catch(err => {
                console.error('FeishuRealtime: Auto-download failed:', err);
                isSyncing = false;
                window.postMessage({ type: 'FEISHU_TOGGLE_CAPTURE', enabled: false }, '*');
            });

        sendResponse({ success: true, message: 'Automation started' });
        return true;
    }
});

// 自动下载流程
async function triggerAutoDownload() {
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 显示操作提示
    showToast('🔄 正在自动下载...', 'info');

    try {
        // Step 1: 找到并点击 "..." 更多按钮
        // 飞书顶部工具栏的更多按钮
        let moreBtn = document.querySelector('[data-testid="header-more-button"]')
            || document.querySelector('button[aria-label="更多"]');

        if (!moreBtn) {
            // 查找包含三个点图标的按钮
            const allButtons = document.querySelectorAll('button, [role="button"]');
            for (const btn of allButtons) {
                const text = btn.textContent?.trim();
                const html = btn.innerHTML;

                // 排除不可见按钮
                if (btn.offsetParent === null) continue;

                // 1. 文本匹配
                if (text === '···' || text === '...' || text === '更多') {
                    moreBtn = btn;
                    break;
                }

                // 2. Class 匹配 (飞书常见 class)
                if (btn.classList.contains('ud__icon') || btn.querySelector('.ud__icon')) {
                    // 检查是否包含更多图标的 SVG
                    if (html.includes('More') || html.includes('more')) {
                        moreBtn = btn;
                        break;
                    }
                }

                // 3. SVG Path 匹配
                if (html.includes('d="M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0') || // 竖向三个点
                    html.includes('d="M3 12a2 2 0 1 0 4 0 2 2 0 0 0-4 0zm') || // 横向三个点
                    btn.querySelector('svg[data-icon="More"]') ||
                    btn.querySelector('svg[data-icon="MoreOutlined"]')) { // 用户提供的准确图标
                    moreBtn = btn;
                    break;
                }
            }
        }

        if (!moreBtn) {
            // 兜底：尝试查找 header 右侧的按钮
            const rightHeader = document.querySelector('.bitable-header-right');
            if (rightHeader) {
                const buttons = rightHeader.querySelectorAll('button');
                if (buttons.length >= 2) {
                    moreBtn = buttons[buttons.length - 2];
                }
            }
        }

        if (!moreBtn) {
            throw new Error('找不到"..."按钮，请确保在多维表格页面');
        }

        console.log('FeishuRealtime: Clicking more button');
        moreBtn.click();

        await delay(600); // 等待菜单展开

        // Step 2: 找到并点击 "导出" 选项
        // 飞书的菜单项使用 role="menuitem", 文本在 span 中
        let exportOption = findMenuItemByDataId('EXPORT') || findMenuItemByText('导出');

        // 增加针对特定 class 的查找
        if (!exportOption) {
            const spans = document.querySelectorAll('.navigation-bar__moreMenu_v3-item__text');
            for (const sp of spans) {
                if (sp.textContent?.trim() === '导出') {
                    // 找到点击区域（通常是父级 li 或 div）
                    exportOption = sp.closest('[role="menuitem"]') || sp.closest('li') || sp;
                    break;
                }
            }
        }

        if (!exportOption) {
            throw new Error('找不到"导出"菜单项');
        }

        console.log('FeishuRealtime: Clicking export option');
        exportOption.click();

        await delay(500); // 等待子菜单展开

        // Step 3: 找到并点击 "多维表格文件" 选项
        // 尝试模拟 hover "导出" 菜单项，以防 click 不触发子菜单
        // 关键修复：确保 hover 到了正确的元素上。
        const mouseoverEvent = new MouseEvent('mouseover', {
            bubbles: true,
            cancelable: true,
            view: window
        });
        const mouseenterEvent = new MouseEvent('mouseenter', {
            bubbles: true,
            cancelable: true,
            view: window
        });
        exportOption.dispatchEvent(mouseoverEvent);
        exportOption.dispatchEvent(mouseenterEvent);

        await delay(800); // 增加等待时间，确保子菜单渲染

        // 查找 "多维表格文件" 的一切可能
        let baseFileOption = null;

        // 优先尝试查找包含特定文本的 span
        // 这是一个非常通用的查找方式，扫瞄所有可见的 "多维表格文件"
        const specificSpans = Array.from(document.querySelectorAll('span')).filter(s => s.textContent?.trim() === '多维表格文件');
        for (const span of specificSpans) {
            // 检查是否在可见区域内 (排除不可见的预渲染元素)
            if (span.offsetParent !== null) {
                baseFileOption = span.closest('li') || span.closest('[role="menuitem"]') || span;
                break;
            }
        }

        if (!baseFileOption) {
            baseFileOption = findMenuItemByDataId('FileBitable')
                || findMenuItemByText('仅数据结构');
        }

        if (!baseFileOption) {
            // 通过 SVG 查找
            const svgIcons = document.querySelectorAll('svg[data-icon="FileBitableColorful"]');
            for (const svg of svgIcons) {
                if (svg.getBoundingClientRect().width > 0) { // 也就是可见
                    const container = svg.closest('li') || svg.closest('[role="menuitem"]');
                    if (container) {
                        baseFileOption = container;
                        break;
                    }
                }
            }
        }

        if (!baseFileOption) {
            // 调试用：列出所有可见的菜单项文本
            const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], li.ud__menu-normal-item'))
                .map(item => item.textContent?.trim())
                .filter(t => t);
            console.log('Visible menu items:', menuItems);

            throw new Error('找不到"多维表格文件"选项');
        }

        console.log('FeishuRealtime: Clicking base file option', baseFileOption);

        // 确保元素可见
        baseFileOption.scrollIntoView({ block: 'center' });
        await delay(100);

        // 暴力点击组合，确保触发
        baseFileOption.click();
        baseFileOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        baseFileOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        await delay(600); // 等待弹窗出现

        // Step 4: 在弹窗中选择 "仅数据结构" 并点击 "确定" 按钮
        // 先查找单选项
        const structureOnlyRadio = findRadioByText('仅数据结构');
        if (structureOnlyRadio) {
            console.log('FeishuRealtime: Selecting structure only option');
            structureOnlyRadio.click();
            await delay(300);
        }

        // 点击确认按钮
        let confirmBtn = null;

        // 1. 优先查找高亮的(filled)主按钮，防止误点取消
        const filledButtons = document.querySelectorAll('.ud__button--filled');
        for (const btn of filledButtons) {
            if (btn.textContent?.trim() === '导出' || btn.textContent?.trim() === '确定') {
                confirmBtn = btn;
                break;
            }
        }

        // 2. 备选：查找任意文本匹配的按钮
        if (!confirmBtn) {
            confirmBtn = findButtonByText('导出') || findButtonByText('确定');
        }

        if (confirmBtn) {
            console.log('FeishuRealtime: Clicking confirm button');
            confirmBtn.click();
            // showToast('✅ 数据已捕获，同步完成', 'success'); // Moved to intercept handler

            // 通知 sidepanel 下载已触发
            chrome.runtime.sendMessage({
                action: 'SYNC_DOWNLOAD_TRIGGERED',
                timestamp: Date.now()
            });

            return { success: true };
        } else {
            // 调试信息：输出所有可见按钮文本
            const allBtns = Array.from(document.querySelectorAll('button')).map(b => b.textContent);
            console.log('Available buttons:', allBtns);
            throw new Error('找不到确认按钮');
        }

    } catch (error) {
        console.error('Auto-download error:', error);
        showToast('⚠️ 自动下载失败: ' + error.message, 'error');

        // 通知 sidepanel 失败
        chrome.runtime.sendMessage({
            action: 'SYNC_DOWNLOAD_FAILED',
            error: error.message
        });

        return { success: false, error: error.message };
    }
}

// 辅助函数：通过文本查找菜单项
function findMenuItemByText(text) {
    // 飞书的菜单项可能在各种容器中
    const selectors = [
        '[role="menuitem"]',
        '[role="option"]',
        '.ud__menu-normal-item',
        '.dropdown-item',
        '.menu-item',
        '[class*="menu"] [class*="item"]'
    ];

    for (const selector of selectors) {
        const items = document.querySelectorAll(selector);
        for (const item of items) {
            if (item.textContent?.includes(text)) {
                return item;
            }
        }
    }

    // 备选：查找所有可点击元素
    const allSpans = document.querySelectorAll('span, div');
    for (const el of allSpans) {
        if (el.textContent?.trim() === text && el.offsetParent !== null) {
            return el;
        }
    }

    return null;
}

// 辅助函数：通过 data-menu-id 查找菜单项
function findMenuItemByDataId(idPart) {
    const items = document.querySelectorAll('[data-menu-id]');
    for (const item of items) {
        const menuId = item.getAttribute('data-menu-id');
        if (menuId && menuId.includes(idPart)) {
            return item;
        }
    }
    return null;
}

// 辅助函数：通过文本查找单选按钮
function findRadioByText(text) {
    // 查找 label 或包含文本的单选项
    const labels = document.querySelectorAll('label, [role="radio"], .ud__radio');
    for (const label of labels) {
        if (label.textContent?.includes(text)) {
            // 尝试点击 label 或其中的 input
            const input = label.querySelector('input[type="radio"]') || label;
            return input;
        }
    }

    // 备选：查找所有包含文本的可点击元素
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
        if (span.textContent?.trim() === text) {
            // 向上查找可点击的父元素
            let parent = span.parentElement;
            while (parent && parent !== document.body) {
                if (parent.matches('[role="radio"], label, .ud__radio, [class*="radio"]')) {
                    return parent;
                }
                parent = parent.parentElement;
            }
            return span;
        }
    }

    return null;
}

// 辅助函数：通过文本查找按钮
function findButtonByText(text) {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
        if (btn.textContent?.trim().includes(text)) {
            return btn;
        }
    }
    return null;
}

// 辅助函数：通过图标查找按钮
function findButtonByIcon(iconText) {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
        if (btn.textContent?.includes(iconText)) {
            return btn;
        }
    }
    return null;
}

// 辅助函数：通过文本查找元素
function findElementByText(tag, text) {
    const elements = document.querySelectorAll(tag);
    for (const el of elements) {
        if (el.textContent?.trim() === text) {
            return el;
        }
    }
    return null;
}

// 显示 Toast 提示
function showToast(message, type = 'info') {
    const existing = document.getElementById('feishu-plugin-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'feishu-plugin-toast';
    toast.textContent = message;

    const colors = {
        info: { bg: '#3370ff', color: 'white' },
        success: { bg: '#34d399', color: 'white' },
        error: { bg: '#ef4444', color: 'white' }
    };
    const style = colors[type] || colors.info;

    toast.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: ${style.bg};
        color: ${style.color};
        padding: 12px 20px;
        border-radius: 8px;
        z-index: 99999;
        font-size: 14px;
        font-weight: 500;
        animation: slideDown 0.3s ease;
    `;

    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
