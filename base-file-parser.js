// base-file-parser.js
// 解析飞书 .base 文件 (移植自 Python)

const BaseFileParser = {
    // 字段类型映射
    FIELD_TYPES: {
        1: "文本", 2: "数字", 3: "单选", 4: "多选", 5: "日期",
        7: "复选框", 11: "人员", 13: "电话", 15: "超链接", 17: "附件",
        18: "关联", 19: "查找引用", 20: "公式", 21: "双向关联",
        22: "地理位置", 23: "群组",
        1001: "创建时间", 1002: "修改时间", 1003: "创建人", 1004: "修改人",
        1005: "自动编号", 3001: "按钮"
    },

    /**
     * 将 JSON 字符串中的大数字转换为字符串，避免精度丢失
     */
    preserveBigIntegers: function (jsonString) {
        // 匹配 "id": 数字 或 "blockToken": 数字 格式，将大数字用引号包裹
        return jsonString.replace(/"(id|blockToken)":\s*(\d{15,})/g, '"$1":"$2"');
    },

    /**
     * 解压 gzip + base64 编码的内容
     */
    decompressContent: function (compressedContent) {
        try {
            // 检查 pako 是否加载
            if (typeof pako === 'undefined') {
                console.error("pako 库未加载");
                return null;
            }

            // Base64 decode
            const binaryString = atob(compressedContent);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            console.log("解压中...", bytes.length, "bytes");

            // Gzip decompress using pako
            let decompressed = pako.ungzip(bytes, { to: 'string' });
            console.log("解压成功, 长度:", decompressed.length);

            // 保护大数字 ID，避免精度丢失
            decompressed = this.preserveBigIntegers(decompressed);

            return JSON.parse(decompressed);
        } catch (e) {
            console.error("解压失败:", e.message, e);
            return null;
        }
    },

    /**
     * 从快照中构建表名和字段名的映射表
     */
    buildNameRegistry: function (snapshot) {
        console.log('开始构建名称映射，快照长度:', snapshot.length);
        
        const tableMap = {};  // {tableId: tableName}
        const fieldMap = {};  // {tableId_fieldId: fieldName}
        const allTables = []; // [{table object}, ...]

        let processedItems = 0;
        let processedTables = 0;
        let processedFields = 0;

        for (const item of snapshot) {
            processedItems++;
            if (!item.schema) continue;

            const schema = item.schema;

            // 从 tableMap 获取表名
            if (schema.tableMap) {
                for (const [tid, tinfo] of Object.entries(schema.tableMap)) {
                    if (tinfo && tinfo.name) {
                        tableMap[tid] = tinfo.name;
                    }
                }
            }

            // 处理 data 中的表结构
            if (!schema.data) continue;

            const data = schema.data;
            let tables = data.tables || [];
            if (data.table) tables.push(data.table);

            for (const table of tables) {
                processedTables++;
                if (!table || typeof table !== 'object') continue;

                allTables.push(table);
                const tableId = table.meta?.id;
                const tableName = table.meta?.name;

                // 只有当表名存在且与表ID不同时才存储
                if (tableId && tableName && !tableMap[tableId]) {
                    tableMap[tableId] = tableName;
                }

                // 提取字段名
                if (tableId && table.fieldMap) {
                    for (const [fieldId, fieldDef] of Object.entries(table.fieldMap)) {
                        processedFields++;
                        const fieldName = fieldDef.name || fieldId;
                        fieldMap[`${tableId}_${fieldId}`] = fieldName;
                    }
                }
            }
        }

        console.log('名称映射构建完成:', 
            '处理项目数:', processedItems, 
            '处理表数:', processedTables, 
            '处理字段数:', processedFields, 
            '最终表数:', Object.keys(tableMap).length, 
            '最终字段数:', Object.keys(fieldMap).length
        );

        return { tableMap, fieldMap, allTables };
    },

    /**
     * 获取字段类型名称
     */
    getFieldTypeName: function (typeId) {
        return this.FIELD_TYPES[typeId] || `未知类型(${typeId})`;
    },

    translateFormula: function (formula, currentTableId, tableMap, fieldMap) {
        if (!formula) return "";

        // 去除冗余前缀
        let result = formula.replace(/bitable::/g, "");

        // 1. 扫描所有的字段引用位置
        const fields = [];
        const fieldRegex = /\$(?:field|column)\[(.*?)\]/g;
        let match;
        while ((match = fieldRegex.exec(result)) !== null) {
            fields.push({
                fid: match[1],
                index: match.index,
                length: match[0].length
            });
        }

        // 2. 从后往前替换，确保索引不偏移
        // 核心逻辑：为每个字段寻找其左侧最近的 $table[ID] 作为上下文
        for (let i = fields.length - 1; i >= 0; i--) {
            const f = fields[i];
            const prefix = result.substring(0, f.index);

            // 在 prefix 中查找最后一个 $table[...]
            const tableMatches = prefix.match(/\$table\[(.*?)\]/g);
            let activeTid = currentTableId;

            if (tableMatches && tableMatches.length > 0) {
                const lastTableMatch = tableMatches[tableMatches.length - 1];
                const tidMatch = lastTableMatch.match(/\$table\[(.*?)\]/);
                if (tidMatch) {
                    activeTid = tidMatch[1];
                }
            }

            // 尝试按上下文查找名称，找不到则按当前表查找
            let fname = fieldMap[`${activeTid}_${f.fid}`] || fieldMap[`${currentTableId}_${f.fid}`];

            // 如果还没找到，则全局搜索该 ID (兜底)
            if (!fname) {
                for (const [key, name] of Object.entries(fieldMap)) {
                    if (key.endsWith(`_${f.fid}`)) {
                        fname = name;
                        break;
                    }
                }
            }

            // 依然找不到则保持原样
            if (!fname) fname = f.fid;

            result = result.substring(0, f.index) + `「${fname}」` + result.substring(f.index + f.length);
        }

        // 3. 最后替换所有的表引用 $table[ID]
        result = result.replace(/\$table\[(.*?)\]/g, (match, tid) => {
            const tname = tableMap[tid] || tid;
            return `「${tname}」`;
        });

        return result;
    },

    /**
     * 提取 AI 字段配置 (一致性移植)
     */
    extractAiConfig: function (fieldDef, fieldMap) {
        // 方式1: ext.ai
        let extAi = fieldDef.ext?.ai;
        if (extAi) {
            const prompts = extAi.prompt || [];
            let promptParts = [];
            for (const p of prompts) {
                if (p.type === 'text') promptParts.push(p.value || '');
                else if (p.type === 'variable') {
                    const fid = p.value?.value?.id;
                    let fname = fid;
                    for (const [key, name] of Object.entries(fieldMap)) {
                        if (key.endsWith(`_${fid}`)) { fname = name; break; }
                    }
                    promptParts.push(`{字段:${fname}}`);
                }
            }
            return { isAi: true, desc: "提示词: " + promptParts.join("") };
        }

        // 方式2: exInfo.customOpenTypeData
        const exInfo = fieldDef.exInfo || {};
        const customData = exInfo.customOpenTypeData;
        if (!customData) return { isAi: false, desc: "" };

        let isAi = false;
        let aiName = "";

        // 判定逻辑
        if (customData.innerType === 'ai_extract' || customData.fieldConfigValue?.aiPrompt) isAi = true;
        if (customData.extensionType === 'field_faas' && customData.category?.includes('Bitable_AI_Menu')) {
            isAi = true;
            aiName = customData.name || 'AI 扩展';
        }
        if (exInfo.aiPaymentInfo?.enableAIPayment) isAi = true;

        if (!isAi) return { isAi: false, desc: "" };

        // 提取配置
        const config = customData.fieldConfigValue || {};
        const formData = config.formData || {};

        // 提取提示词 - 确保是字符串类型
        let promptText = formData.promptEdit || formData.content || formData.custom_rules || "";
        // 确保 promptText 是字符串
        if (typeof promptText !== 'string') {
            promptText = "";
        }

        // 提取来源字段
        let sourceField = "";
        const sourceObj = formData.source || formData.choiceColumn || {};
        const sourceId = sourceObj.id || "";
        if (sourceId) {
            for (const [key, name] of Object.entries(fieldMap)) {
                if (key.endsWith(`_${sourceId}`)) { sourceField = name; break; }
            }
            if (!sourceField) sourceField = sourceId;
        }

        const descParts = [];
        if (aiName) descParts.push(`类型: ${aiName}`);
        if (sourceField) descParts.push(`来源字段: 「${sourceField}」`);
        if (promptText) {
            let preview = promptText.replace(/\n/g, " ");
            descParts.push(`提示词: ${preview}`);
        }

        return { isAi: true, desc: descParts.length > 0 ? descParts.join(" | ") : "AI 字段" };
    },

    /**
     * 从公式提取筛选条件
     */
    extractFilterConditions: function (formula, currentTableId, tableMap, fieldMap) {
        if (!formula) return "";
        const conditions = [];

        // 简单的正则提取 .FILTER(...)
        const filterMatches = formula.match(/\.FILTER\((.*?)\)/s);
        if (filterMatches) {
            const filterExpr = filterMatches[1];

            // 等于条件
            const eqRegex = /CurrentValue\.\$(?:column|field)\[(.*?)\]\s*=\s*([^&)]+)/g;
            let match;
            while ((match = eqRegex.exec(filterExpr)) !== null) {
                const leftFid = match[1];
                const rightExpr = match[2];

                let leftFname = fieldMap[`${currentTableId}_${leftFid}`] || leftFid;
                // 全局查找兜底
                if (leftFname === leftFid) {
                    for (const [key, name] of Object.entries(fieldMap)) {
                        if (key.endsWith(`_${leftFid}`)) { leftFname = name; break; }
                    }
                }
                const rightTranslated = this.translateFormula(rightExpr.trim(), currentTableId, tableMap, fieldMap);
                conditions.push(`「${leftFname}」= ${rightTranslated}`);
            }
            // 不等于条件 (略，为保持简单)
        }
        return conditions.join(" 且 ");
    },

    /**
     * 提取字段配置 (完整版)
     */
    extractFieldConfig: function (fieldDef, currentTableId, tableMap, fieldMap) {
        const fieldType = fieldDef.type;
        const prop = fieldDef.property || {};

        // AI 字段检查
        const { isAi, desc: aiDesc } = this.extractAiConfig(fieldDef, fieldMap);

        let configText = "-";

        // 公式
        if (fieldType === 20) {
            const formula = prop.formula || "";
            const translated = this.translateFormula(formula, currentTableId, tableMap, fieldMap);
            configText = `\`${translated}\``;
        }

        // 单选/多选
        else if (fieldType === 3 || fieldType === 4) {
            const options = prop.options || [];
            const optionNames = options.map(o => o.name || "").join(", ");

            const optionsRule = prop.optionsRule || {};
            if (optionsRule.targetTable) {
                const targetTid = optionsRule.targetTable;
                const targetFid = optionsRule.targetField;
                const targetTname = tableMap[targetTid] || targetTid;
                const targetFname = fieldMap[`${targetTid}_${targetFid}`] || targetFid;
                configText = `选项同步自「${targetTname}」的「${targetFname}」`;
            } else {
                configText = `选项: ${optionNames}`;
            }
        }

        // 查找引用
        else if (fieldType === 19) {
            const filterInfo = prop.filterInfo || {};
            const targetTid = filterInfo.targetTable;
            const targetFid = prop.targetField;
            if (targetTid) {
                const targetTname = tableMap[targetTid] || `[已删除的表:${targetTid}]`;
                const targetFname = fieldMap[`${targetTid}_${targetFid}`] ||
                    Object.entries(fieldMap).find(e => e[0].endsWith(`_${targetFid}`))?.[1] ||
                    `[已删除的字段:${targetFid}]`;

                configText = `查找引用自「${targetTname}」的「${targetFname}」`;

                const lookupFormula = prop.formula || "";
                if (lookupFormula) {
                    const conds = this.extractFilterConditions(lookupFormula, currentTableId, tableMap, fieldMap);
                    if (conds) configText += `<br>筛选条件: ${conds}`;
                }
            }
        }

        // 关联
        else if (fieldType === 18 || fieldType === 21) {
            const targetTid = prop.tableId;
            if (targetTid) {
                const targetName = tableMap[targetTid] || `[已删除的表:${targetTid}]`;
                configText = `关联到「${targetName}」`;
            }
        }

        // 自动编号
        else if (fieldType === 1005) {
            const rules = prop.ruleFieldOptions || [];
            const ruleDesc = rules.map(r => {
                if (r.type === 1) return `{创建时间:${r.value}}`;
                if (r.type === 2) return `"${r.value}"`;
                if (r.type === 3) return `{自增数字:${r.value}位}`;
                return `{未知:${r.value}}`;
            });
            configText = ruleDesc.length ? `规则: ${ruleDesc.join(' + ')}` : "自动编号";
        }

        // 日期
        else if (fieldType === 5) {
            const fmt = [prop.dateFormat, prop.timeFormat].filter(Boolean).join(" ");
            configText = fmt ? `格式: ${fmt}` : "日期";
            if (prop.autoFill) configText += " (自动填入创建时间)";
        }

        // 数字
        else if (fieldType === 2) {
            configText = prop.formatter ? `格式: ${prop.formatter}` : "数字";
        }

        // 按钮
        else if (fieldType === 3001) {
            const title = prop.button?.title || "未命名";
            configText = `按钮: [${title}]`;
        }

        // 附件
        else if (fieldType === 17) {
            configText = "允许上传附件";
        }

        // 其他
        else if (Object.keys(prop).length > 0) {
            configText = JSON.stringify(prop);
        }

        // 组合 AI 描述
        if (isAi && aiDesc) {
            configText = `**AI配置**: ${aiDesc}<br><br>${configText}`;
        }

        return { configText, isAi, aiDesc, description: fieldDef.description?.text || "" };
    },

    /**
     * 生成全量字段表 Markdown
     */
    generateFieldTable: function (allTables, tableMap, fieldMap) {
        let md = `# 全量字段表\n\n`;
        md += `> 生成时间: ${new Date().toLocaleString()}\n`;
        md += `> 数据表总数: ${allTables.length}\n\n`;

        // 按表名排序
        const sortedTables = allTables.sort((a, b) => {
            const nameA = tableMap[a.meta?.id] || "";
            const nameB = tableMap[b.meta?.id] || "";
            return nameA.localeCompare(nameB);
        });

        for (const table of sortedTables) {
            const tableId = table.meta?.id;
            const tableName = tableMap[tableId] || tableId;
            const fieldMapData = table.fieldMap || {};

            md += `## 📊 ${tableName}\n\n`;
            md += `- 表 ID: \`${tableId}\`\n`;
            md += `- 字段数量: ${Object.keys(fieldMapData).length}\n\n`;

            md += `| 字段名称 | 字段类型 | 是否AI字段 | 业务描述 | 完整配置/公式 | 字段ID |\n`;
            md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

            // 按字段名排序
            const sortedFields = Object.entries(fieldMapData).sort((a, b) => {
                return (a[1].name || "").localeCompare(b[1].name || "");
            });

            for (const [fieldId, fieldDef] of sortedFields) {
                const fieldName = fieldDef.name || fieldId;
                const fieldType = this.getFieldTypeName(fieldDef.type);

                const { configText, isAi, description } = this.extractFieldConfig(fieldDef, tableId, tableMap, fieldMap);

                // 清理配置文本
                const configClean = configText.replace(/\n/g, " ").replace(/\|/g, "\\|");
                const descClean = (description || "").replace(/\n/g, " ");
                const aiMarker = isAi ? "🤖 是" : "否";

                md += `| **${fieldName}** | ${fieldType} | ${aiMarker} | ${descClean} | ${configClean} | \`${fieldId}\` |\n`;
            }

            md += `\n---\n\n`;
        }

        return md;
    },

    /**
     * 主入口：解析 .base 文件内容 (返回结构化数据供 JSON Diff 使用)
     */
    parseBaseFileStruct: function (fileContent) {
        try {
            const data = JSON.parse(fileContent);

            // 1. 解压快照
            const snapshot = this.decompressContent(data.gzipSnapshot);
            if (!snapshot) {
                return { success: false, error: "快照解压失败" };
            }

            // 2. 构建名称映射
            const { tableMap, fieldMap, allTables } = this.buildNameRegistry(snapshot);

            // 3. 构建结构化表格数据 (ID keyed)
            const tablesStruct = {};
            for (const table of allTables) {
                const tid = table.meta?.id;
                if (!tid) continue;

                const fieldsStruct = {};
                if (table.fieldMap) {
                    for (const [fid, fdef] of Object.entries(table.fieldMap)) {
                        fieldsStruct[fid] = {
                            id: fid,
                            name: fdef.name,
                            type: fdef.type,
                            property: fdef.property, // 保留原始属性用于对比
                            description: fdef.description?.text
                        };
                    }
                }

                tablesStruct[tid] = {
                    id: tid,
                    name: tableMap[tid] || table.meta.name,
                    fields: fieldsStruct
                };
            }

            return {
                success: true,
                projectData: {
                    tables: tablesStruct,
                    automation: {
                        gzip: data.gzipAutomation, // 稍后由 AutomationParser 处理
                        // 如果有 blockInfos 也带上
                        blockInfos: snapshot[0]?.schema?.base?.blockInfos // 辅助获取工作流名称
                    }
                },
                maps: { tableMap, fieldMap }
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * 主入口：解析 .base 文件内容 (兼容旧版 Markdown 输出)
     */
    parseBaseFile: function (fileContent) {
        try {
            console.log('开始解析文件，大小:', (fileContent.length / 1024).toFixed(1), 'KB');
            
            // 检查文件大小
            if (fileContent.length > 10 * 1024 * 1024) { // 10MB
                console.warn('文件较大，可能需要较长时间解析');
            }

            // 解析 JSON
            console.log('解析 JSON 数据...');
            const data = JSON.parse(fileContent);

            // 1. 解压快照
            console.log('解压快照数据...');
            const snapshot = this.decompressContent(data.gzipSnapshot);
            if (!snapshot) {
                console.error('快照解压失败');
                return { success: false, error: "快照解压失败" };
            }
            console.log('快照解压成功，包含', snapshot.length, '个项目');

            // 2. 构建名称映射
            console.log('构建名称映射...');
            const { tableMap, fieldMap, allTables } = this.buildNameRegistry(snapshot);
            console.log('名称映射构建完成，', Object.keys(tableMap).length, '张表，', Object.keys(fieldMap).length, '个字段');

            // 3. 生成文档
            console.log('生成字段表 Markdown...');
            const fieldTableMd = this.generateFieldTable(allTables, tableMap, fieldMap);
            console.log('字段表生成完成，长度:', fieldTableMd.length, '字符');

            return {
                success: true, // 保持 success 字段
                tableCount: Object.keys(tableMap).length,
                fieldCount: Object.keys(fieldMap).length,
                fieldTableMd: fieldTableMd,
                // 保存原始数据供后续使用 (关联关系图、自动化地图、校验器)
                rawData: {
                    tableMap,
                    fieldMap,
                    allTables,
                    snapshot,  // 供 blockMap 构建
                    gzipAutomation: data.gzipAutomation  // 供自动化地图解析
                }
            };
        } catch (e) {
            console.error('解析失败:', e);
            // 提供更详细的错误信息
            let errorMsg = e.message;
            if (e instanceof SyntaxError) {
                errorMsg = `JSON解析错误: ${e.message}`;
            } else if (e instanceof RangeError) {
                errorMsg = `内存不足: ${e.message}`;
            }
            return { success: false, error: errorMsg };
        }
    }
};

// Export for testing in Node.js
if (typeof module !== 'undefined') {
    module.exports = BaseFileParser;
}
