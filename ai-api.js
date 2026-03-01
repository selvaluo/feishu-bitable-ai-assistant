// ai-api.js
// AI API 封装 - 支持多提供商 (OpenAI, OpenRouter, DeepSeek, 豆包等)

const AIApi = {
    // 默认配置
    DEFAULT_MODEL: 'gpt-4o',
    DEFAULT_ENDPOINT: 'https://api.openai.com/v1/chat/completions',

    // AI 提供商配置
    PROVIDERS: {
        'openai': {
            name: 'OpenAI',
            endpoint: 'https://api.openai.com/v1/chat/completions',
            modelsEndpoint: 'https://api.openai.com/v1/models',
            visionModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4-vision-preview']
        },
        'openrouter': {
            name: 'OpenRouter',
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            modelsEndpoint: 'https://openrouter.ai/api/v1/models',
            headers: {
                'HTTP-Referer': 'https://github.com/feishu-realtime-plugin',
                'X-Title': 'Feishu Bitable Architect'
            }
        },
        'deepseek': {
            name: 'DeepSeek',
            endpoint: 'https://api.deepseek.com/chat/completions',
            modelsEndpoint: 'https://api.deepseek.com/models',
            visionModels: []
        },
        'siliconflow': {
            name: 'SiliconFlow (硅基流动)',
            endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
            modelsEndpoint: 'https://api.siliconflow.cn/v1/models'
        },
        'volcengine': {
            name: '豆包 (火山引擎)',
            endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
            modelsEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/models'
        },
        'kimi': {
            name: 'Kimi (Moonshot)',
            endpoint: 'https://api.moonshot.cn/v1/chat/completions',
            modelsEndpoint: 'https://api.moonshot.cn/v1/models'
        },
        'qwen': {
            name: '通义千问 (Qwen)',
            endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            modelsEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models'
        },
        'google': {
            name: 'Google Gemini',
            endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
            modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/models'
        },
        'anthropic': {
            name: 'Anthropic (Claude)',
            endpoint: 'https://api.anthropic.com/v1/messages',
            modelsEndpoint: 'https://openrouter.ai/api/v1/models', // Anthropic 原生不直接支持 OpenAI 协议获取模型，通常建议通过 OpenRouter
            visionModels: ['claude-3-5-sonnet-20240620', 'claude-3-opus-20240229']
        }
    },

    /**
     * 获取 AI 提供商
     */
    getProvider: async function () {
        return new Promise(resolve => {
            chrome.storage.local.get(['ai_provider'], result => {
                resolve(result.ai_provider || 'openai');
            });
        });
    },

    /**
     * 保存 AI 提供商
     */
    setProvider: async function (provider) {
        return new Promise(resolve => {
            chrome.storage.local.set({ ai_provider: provider }, resolve);
        });
    },

    /**
     * 获取当前提供商特定的 API Key
     */
    getApiKey: async function () {
        const provider = await this.getProvider();
        return new Promise(resolve => {
            chrome.storage.local.get([`ai_api_key_${provider}`], result => {
                resolve(result[`ai_api_key_${provider}`] || '');
            });
        });
    },

    /**
     * 保存 API Key
     */
    setApiKey: async function (key) {
        const provider = await this.getProvider();
        const data = {};
        data[`ai_api_key_${provider}`] = key;
        return new Promise(resolve => {
            chrome.storage.local.set(data, resolve);
        });
    },

    /**
     * 获取 API Endpoint
     */
    getEndpoint: async function () {
        const provider = await this.getProvider();
        return new Promise(resolve => {
            chrome.storage.local.get([`ai_endpoint_${provider}`], result => {
                resolve(result[`ai_endpoint_${provider}`] || this.PROVIDERS[provider]?.endpoint || this.DEFAULT_ENDPOINT);
            });
        });
    },

    /**
     * 保存 API Endpoint
     */
    setEndpoint: async function (url) {
        const provider = await this.getProvider();
        // 自动补全路径 (豆包 v3 接口稍有不同，不强制加 chat/completions)
        if (url && !url.includes('chat/completions') && !url.includes('api/v3')) {
            url = url.replace(/\/$/, '') + '/chat/completions';
        }
        const data = {};
        data[`ai_endpoint_${provider}`] = url;
        return new Promise(resolve => {
            chrome.storage.local.set(data, resolve);
        });
    },

    /**
     * 获取当前模型
     */
    getModel: async function () {
        const provider = await this.getProvider();
        return new Promise(resolve => {
            chrome.storage.local.get([`ai_model_${provider}`], result => {
                resolve(result[`ai_model_${provider}`] || (provider === 'openai' ? this.DEFAULT_MODEL : ''));
            });
        });
    },

    /**
     * 保存模型选择
     */
    setModel: async function (model) {
        const provider = await this.getProvider();
        const data = {};
        data[`ai_model_${provider}`] = model;
        return new Promise(resolve => {
            chrome.storage.local.set(data, resolve);
        });
    },

    // 默认系统提示词模板（与 docs/系统提示词 保持同步）
    DEFAULT_SYSTEM_TEMPLATE: `# Role: Feishu Multidimensional Table Architect (飞书多维表格架构师)

## 0. 核心指令 (Core Directives)
- 你不是客服，你是**系统架构师**。
- **禁止**任何形式的寒暄、过渡语（如“这是一个很好的问题”、“希望能帮到你”）。
- **禁止**给出模棱两可的建议（如"可能取决于..."、"建议您尝试..."），给出明确的结论或建议。
- **原则上**基于用户当前的[数据结构]和[工作流]进行诊断。但若用户仅咨询设计思路或系统尚处于构思阶段（无现有数据），则**不强制**要求提供截图或具体数据结构，可基于通用场景给出架构建议。
- **沟通风格**：像一个耐心的同事在工位旁解释问题。用非技术用户也能理解的语言，先回答用户的直接疑问，再按需补充深层建议。
- **自适应输出**：根据问题的复杂度调整回答方式——简单问题直接说结论，复杂的架构设计再给出结构化方案。不要生硬地套用固定格式。

## 1. 核心能力 (Capabilities)
### A. 数据库架构设计 (Database Architecture)
- 将多维表格视为关系型数据库(RDBMS)，而非Excel。
- 能够识别并在设计中应用范式（Normalization），解决数据冗余。
- 定义“引用”与“双向关联”的拓扑结构。

### B. 自动化工作流编排 (Workflow Orchestration)
- 将 "Trigger -> Action" 逻辑与业务场景深度绑定。
- 擅长使用“查找记录”、“更新记录”解决跨表数据同步问题。
- 设计闭环流程（例如：审批后自动回写状态）。

### C. AI 算力字段工程 (AI Field Engineering)
- **非结构化清洗**：设计AI指令从长文本/聊天记录中提取关键字段（金额、日期、人名）。
- **多模态提取**：设计AI指令从图片/单据中提取结构化信息（OCR+语义理解）。
- **Prompt 调优**：为AI字段编写精准的“输入/输出”约束。

### D. 飞书字段类型映射 (Bitable Field Types)
- **基础字段**: 单行/多行文本, 数字(支持进度/货币/评分), 单选/多选, 日期, 复选框.
- **高级字段**:
  - \`人员 (Person)\`: 关联飞书组织架构。
  - \`单向/双向关联 (Link)\`: **区别于 SQL 外键**。仅作为"记录间的指针"，支持点击跳转查看详情，**不直接同步数据**。
  - \`查找引用 (Lookup)\`: **数据同步专用**。必须依附于关联字段，用于将关联表的字段值实时同步/展示到当前表 (Read-only)。
  - \`公式 (Formula)\`: 支持 100+ 函数（可引用关联字段）。
  - \`AI 字段 (AI Shortcuts)\`: 基于大模型的字段，支持 "AI 提取" (从文本/图片提取结构化数据到单选/多选/文本字段)、"AI 分类"、"AI 生成"。
  - \`附件 (Attachment)\`: 存储文件/图片。
  - \`自动编号 (Auto Number)\`: 系统自动生成的唯一 ID。
- **禁止使用**: SQL DDL, VARCHAR, Foreign Key 等非飞书原生术语。

## 2. 交互协议 (Interaction Protocol)

### 阶段一：诊断 (Diagnosis)
用户输入问题后，首先判断信息是否足够支持架构决策。
- 若不足：直接列出缺少的关键信息点（如：需要当前表格的截图、字段列表、或工作流的触发条件）。
- 若足够：进入阶段二。

### 阶段二：回答 (Response)
根据问题复杂度自适应输出：简单问题直接回答结论，无需套用格式。仅在用户需要架构设计或系统改造建议时，使用以下结构化格式：

#### 【方案一：XXX策略】（首选推荐）
- **架构逻辑**：一句话解释为什么要这样设计（从数据库/效率角度）。
- **字段配置**：
  - \`[字段名]\`: \`[字段类型]\` -> \`[配置逻辑/AI Prompt写法]\`
- **工作流设计**：
  - 触发器：XXX
  - 节点1：XXX
  - 节点2：XXX

#### 【方案二：XXX策略】（备选，仅在方案一有明显局限时提供）
- **差异点**：相比方案一的优劣势简述。

## 3. 卫兵指令 (Guardrails)
- ❌ **严禁**建议用户“手动复制粘贴”。
- ❌ **严禁**在AI字段配置中写“请帮我...”，直接写指令动作。
- ✅ **始终**优先考虑“引用字段”和“仪表盘”的数据可视化需求。`,

    /**
     * 获取系统提示词模板
     */
    getSystemPromptTemplate: async function () {
        return new Promise(resolve => {
            chrome.storage.local.get(['ai_system_template'], result => {
                resolve(result.ai_system_template || this.DEFAULT_SYSTEM_TEMPLATE);
            });
        });
    },

    /**
     * 保存系统提示词模板
     */
    setSystemPromptTemplate: async function (template) {
        return new Promise(resolve => {
            chrome.storage.local.set({ ai_system_template: template }, resolve);
        });
    },

    /**
     * 构建完整的 System Prompt
     */
    buildSystemPrompt: async function (documents) {
        const template = await this.getSystemPromptTemplate();

        const getDocPlaceholder = (content) => {
            if (content === null) return '(加载异常：未获取到文档数据)';
            if (!content || content.trim() === '') return '(用户未勾选对此部分数据的引用)';
            return content;
        };

        const variablePart = `
## 当前文档 (变量部分 - 自动生成)
### 1. 全量字段表 (field_table)
\`\`\`markdown
${getDocPlaceholder(documents.fieldTable)}
\`\`\`
### 2. 自动化地图 (automation_map)
\`\`\`markdown
${getDocPlaceholder(documents.automationMap)}
\`\`\`
### 3. 关联关系图 (relation_graph)
\`\`\`markdown
${getDocPlaceholder(documents.relationGraph)}
\`\`\`
`;
        return template + "\n\n" + variablePart;
    },

    /**
     * 发送消息到 AI API
     */
    chat: async function (messages, documents, imageBase64 = null) {
        const provider = await this.getProvider();
        const apiKey = await this.getApiKey();
        if (!apiKey) throw new Error('请先配置 API Key');

        const endpoint = await this.getEndpoint();
        const model = await this.getModel();
        const systemPrompt = await this.buildSystemPrompt(documents);

        // [调试日志] 记录系统提示词长度和文档数据状态
        console.log(`[Debug AIApi] System Prompt 长度: ${systemPrompt.length} 字符`);
        console.log(`[Debug AIApi] 文档数据: fieldTable=${documents?.fieldTable?.length || 0}字符, automationMap=${documents?.automationMap?.length || 0}字符, relationGraph=${documents?.relationGraph?.length || 0}字符`);
        console.log(`[Debug AIApi] 历史消息数量: ${messages.length}`);

        // [Debug] 记录最后一次发送的 System Prompt，供用户核对
        this.lastSystemPrompt = systemPrompt;

        const apiMessages = [{ role: 'system', content: systemPrompt }];

        // 识别当前模型是否支持 Vision
        const isVisionSupported = await this.checkVisionSupport(model);

        for (const msg of messages) {
            if (msg.role === 'user' && msg.image && isVisionSupported) {
                apiMessages.push({
                    role: 'user',
                    content: [
                        { type: 'text', text: msg.content },
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${msg.image}`, detail: 'high' } }
                    ]
                });
            } else {
                apiMessages.push({ role: msg.role, content: msg.content });
            }
        }

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        const providerConfig = this.PROVIDERS[provider];
        if (providerConfig?.headers) {
            Object.assign(headers, providerConfig.headers);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    model: model,
                    messages: apiMessages,
                    max_tokens: 4096,
                    temperature: 0.7
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.error?.message || `API 错误: ${response.status}`);
            }

            const data = await response.json();
            return {
                content: data.choices[0]?.message?.content || '',
                updates: null
            };
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new Error('请求超时 (60s)');
            throw error;
        }
    },

    /**
     * 检查模型是否支持 Vision
     */
    checkVisionSupport: async function (model) {
        if (!model) return false;
        const provider = await this.getProvider();
        const config = this.PROVIDERS[provider];
        if (config?.visionModels?.includes(model)) return true;
        const lowModel = model.toLowerCase();
        if (lowModel.includes('vision') || lowModel.includes('gpt-4o') || lowModel.includes('claude-3-5') || lowModel.includes('gemini-1.5')) return true;

        return new Promise(resolve => {
            chrome.storage.local.get([`ai_models_cache_${provider}`], result => {
                const models = result[`ai_models_cache_${provider}`] || [];
                const modelInfo = models.find(m => m.id === model);
                resolve(!!modelInfo?.vision);
            });
        });
    },

    /**
     * 测试 API Key 是否有效
     */
    testApiKey: async function (key) {
        const provider = await this.getProvider();
        const endpoint = await this.getEndpoint();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        try {
            // 获取模型，优先使用缓存的模型列表，否则使用默认模型
            let model;
            const models = await this.getAvailableModels();
            if (models.length > 0) {
                model = models[0].id;
            } else {
                // 为不同提供商设置合理的默认模型
                switch (provider) {
                    case 'openai':
                        model = 'gpt-4o-mini';
                        break;
                    case 'deepseek':
                        model = 'deepseek-chat';
                        break;
                    case 'siliconflow':
                        model = 'deepseek-ai/DeepSeek-V3';
                        break;
                    case 'volcengine':
                        model = 'ep-20240510171746-xqxzh';
                        break;
                    case 'kimi':
                        model = 'moonshot-v1-8k';
                        break;
                    case 'qwen':
                        model = 'qwen-plus';
                        break;
                    case 'google':
                        model = 'gemini-1.5-flash';
                        break;
                    case 'anthropic':
                        model = 'claude-3-sonnet-20240229';
                        break;
                    default:
                        model = 'gpt-4o-mini';
                }
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            return { valid: response.ok, error: response.ok ? null : `状态码: ${response.status}` };
        } catch (e) {
            clearTimeout(timeoutId);
            return { valid: false, error: e.name === 'AbortError' ? '连接超时 (10s)' : e.message };
        }
    },

    /**
     * 动态从提供商拉取模型列表
     */
    fetchAvailableModels: async function () {
        const provider = await this.getProvider();
        const apiKey = await this.getApiKey();
        const config = this.PROVIDERS[provider];

        if (!apiKey) throw new Error('请先输入并保存 API Key');
        if (!config?.modelsEndpoint) throw new Error(`当前提供商 ${provider} 不支持自动获取模型列表`);

        const response = await fetch(config.modelsEndpoint, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error?.message || `获取模型失败: ${response.status}`);
        }

        const data = await response.json();
        const rawModels = data.data || data.models || [];

        const models = rawModels.map(m => {
            const id = m.id;
            const vision = id.toLowerCase().includes('vision') || id.toLowerCase().includes('gpt-4o') || id.toLowerCase().includes('claude-3-5');
            return { id: id, name: m.name || id, vision: vision };
        });

        const cacheData = {};
        cacheData[`ai_models_cache_${provider}`] = models;
        await new Promise(resolve => chrome.storage.local.set(cacheData, resolve));

        return models;
    },

    /**
     * 获取缓存的模型列表
     */
    getAvailableModels: async function () {
        const provider = await this.getProvider();
        return new Promise(resolve => {
            chrome.storage.local.get([`ai_models_cache_${provider}`], result => {
                resolve(result[`ai_models_cache_${provider}`] || []);
            });
        });
    }
};

if (typeof module !== 'undefined') {
    module.exports = AIApi;
}
