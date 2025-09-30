import express from 'express';
import * as falClient from '@fal-ai/client';
import { randomUUID } from 'crypto';

const fal = falClient.fal;

// ========================================
// 配置
// ========================================
const PORT = process.env.PORT || 8080;

// 模型映射配置
let MODEL_MAPPING = {};
try {
  const mappingEnv = process.env.MODEL_MAPPING || '{}';
  MODEL_MAPPING = JSON.parse(mappingEnv);
  console.log('📋 模型映射配置:', MODEL_MAPPING);
} catch (e) {
  console.warn('⚠️  模型映射配置解析失败，使用空映射:', e.message);
}

function mapModel(requestModel) {
  const mapped = MODEL_MAPPING[requestModel] || requestModel;
  if (mapped !== requestModel) {
    console.log(`🔄 模型映射: ${requestModel} → ${mapped}`);
  }
  return mapped;
}

// ========================================
// 工具函数
// ========================================

function uuid() {
  return randomUUID().replace(/-/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ========================================
// XML 工具函数
// ========================================

function escapeXML(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeCDATA(text) {
  // ]]> 必须拆分为 ]]]]><![CDATA[>
  return text.replace(/]]>/g, ']]]]><![CDATA[>');
}

// ========================================
// Prompt 构建器
// ========================================

function buildSystemPrompt(messages, system) {
  const parts = [];

  // 顶层 system
  if (system) {
    if (typeof system === 'string') {
      parts.push(system.trim());
    } else if (Array.isArray(system)) {
      // 支持 prompt caching 数组格式
      for (const block of system) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text.trim());
        }
      }
    }
  }

  // messages 中的 system/developer
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const content = msg.content;
      if (typeof content === 'string') {
        parts.push(content.trim());
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text.trim());
          }
        }
      }
    }
  }

  return parts.filter(Boolean).join('\n\n');
}

function buildToolsXML(tools) {
  if (!tools || tools.length === 0) return '';

  const lines = [
    '<tools>',
    '  <note>以下为当前可用工具，动态变化；仅可调用列出的工具。</note>'
  ];

  for (const tool of tools) {
    const name = escapeXML(tool.name || '');
    const description = escapeXML(tool.description || '');
    const schema = JSON.stringify(tool.input_schema || {});

    lines.push(`  <tool name="${name}">`);
    lines.push(`    <description>${description}</description>`);
    lines.push('    <parameters>');
    lines.push(`      <json_schema><![CDATA[${escapeCDATA(schema)}]]></json_schema>`);
    lines.push('    </parameters>');
    lines.push('  </tool>');
  }

  lines.push('</tools>');
  return lines.join('\n');
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const texts = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text);
    }
    // 忽略图片 (image) 和其他非文本内容
  }
  return texts.join('\n');
}

function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(block => block.type === 'tool_use');
}

function extractToolResults(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(block => block.type === 'tool_result');
}

function buildConversationHistory(messages) {
  const historyParts = [];
  let currentMessage = '';

  // 过滤掉 system/developer
  const filtered = messages.filter(m => !['system', 'developer'].includes(m.role));

  for (let i = 0; i < filtered.length; i++) {
    const msg = filtered[i];
    const isLast = (i === filtered.length - 1);

    if (msg.role === 'user') {
      const text = extractText(msg.content);
      const toolResults = extractToolResults(msg.content);

      if (isLast) {
        // 最后一条消息
        if (toolResults.length > 0) {
          // 有 tool_result，作为当前消息
          const resultXMLs = toolResults.map(tr => {
            const callId = escapeXML(tr.tool_use_id || '');
            const resultText = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
            return `<tool_result call_id="${callId}"><![CDATA[${escapeCDATA(resultText)}]]></tool_result>`;
          });
          currentMessage = `<tool_results>\n${resultXMLs.join('\n')}\n</tool_results>`;
        } else {
          // 纯文本，作为当前消息
          currentMessage = text;
        }
      } else {
        // 历史消息
        if (text) {
          historyParts.push(`<user>${text}</user>`);
        }
        // 历史中的 tool_result
        for (const tr of toolResults) {
          const callId = escapeXML(tr.tool_use_id || '');
          const resultText = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
          historyParts.push(`<tool_result call_id="${callId}"><![CDATA[${escapeCDATA(resultText)}]]></tool_result>`);
        }
      }
    } else if (msg.role === 'assistant') {
      const text = extractText(msg.content);
      const toolUses = extractToolUses(msg.content);

      let assistantXML = '';
      if (text) {
        assistantXML = `<assistant>${text}</assistant>`;
      }

      if (toolUses.length > 0) {
        const toolCallXMLs = ['<assistant_tool_calls>'];
        for (const tu of toolUses) {
          const callId = escapeXML(tu.id || '');
          const name = escapeXML(tu.name || '');
          const inputJSON = JSON.stringify(tu.input || {});
          toolCallXMLs.push(`<tool_call name="${name}" call_id="${callId}">`);
          toolCallXMLs.push(`<arguments><![CDATA[${escapeCDATA(inputJSON)}]]></arguments>`);
          toolCallXMLs.push('</tool_call>');
        }
        toolCallXMLs.push('</assistant_tool_calls>');
        assistantXML += '\n' + toolCallXMLs.join('\n');
      }

      if (!isLast) {
        historyParts.push(assistantXML);
      } else {
        currentMessage = assistantXML;
      }
    }
  }

  const historyXML = historyParts.length > 0
    ? `<conversation_history>\n${historyParts.join('\n')}\n</conversation_history>`
    : '';

  return { historyXML, currentMessage };
}

function buildToolCallRules(hasTools) {
  if (!hasTools) return '';

  return `<tool_call_rules>
  <rule>工具是动态的，只能调用本轮 &lt;tools&gt; 中出现的 name。</rule>
  <rule>若要调用工具，必须输出 &lt;tool_calls&gt;...&lt;/tool_calls&gt; 并以闭合标签结尾；之后禁止输出任何内容（包括空白）。</rule>
  <rule>允许在 &lt;tool_calls&gt; 前输出部分回答。</rule>
  <rule>禁止模拟或编造工具的执行结果，不要输出工具结果或 &lt;tool_result&gt;。</rule>
  <rule>线性依赖：若一个工具依赖另一个工具的结果，本轮仅输出一个 &lt;tool_call&gt;；待真实结果（role=tool）作为历史被注入后，在下一轮再决定下一个调用。</rule>
  <rule>不得预先假设上一工具的结果，也不得据此构造后续调用的参数；必须等待真实结果。</rule>
  <rule>若可以并行，本轮可在同一 &lt;tool_calls&gt; 中列出多个 &lt;tool_call&gt;，表示并行执行。</rule>
  <rule>调用参数必须是严格 JSON（UTF-8，无注释，双引号）。</rule>
</tool_call_rules>`;
}

function buildOutputFormat(hasTools) {
  if (!hasTools) return '';

  return `<output_format><![CDATA[
你只能使用以下两种输出之一：
1) 仅回答内容（当无需调用工具时）
2) （可选）部分回答
   <tool_calls>
     <tool_call name="TOOL_NAME">
       <arguments>{...严格 JSON...}</arguments>
     </tool_call>
     ...（可有多项，表示并行；线性则仅写一个）
   </tool_calls>
   （禁止任何后续文本）
]]></output_format>`;
}

function buildInstructions(hasHistory, hasTools) {
  if (!hasHistory) return '';

  const lines = [
    '<instructions>',
    '请基于以上内容回答用户的新问题。',
    '- 仅直接回答，不要模拟/编造多轮对话，不要输出任何对话标签（user、assistant），也不要仿写角色切换。'
  ];

  if (hasTools) {
    lines.push('- 若需要调用工具，可按本轮系统约定输出工具相关的 XML（如 <tool_calls>），并严格遵守调用规则；禁止模拟工具执行结果。');
  }

  lines.push('</instructions>');
  return lines.join('\n');
}

function buildPrompt(messages, system, tools) {
  // 1. 合并 system
  const baseSystem = buildSystemPrompt(messages, system);

  // 2. 构建历史和当前消息
  const { historyXML, currentMessage } = buildConversationHistory(messages);

  // 3. 工具清单
  const toolsXML = buildToolsXML(tools);

  // 4. 规则和格式
  const hasTools = tools && tools.length > 0;
  const instructions = buildInstructions(!!historyXML, hasTools);
  const rules = buildToolCallRules(hasTools);
  const format = buildOutputFormat(hasTools);

  // 5. 组装 systemPrompt
  const systemParts = [];
  if (baseSystem) {
    systemParts.push(`<system>\n${baseSystem}\n</system>`);
  }
  if (historyXML) systemParts.push(historyXML);
  if (instructions) systemParts.push(instructions);
  if (toolsXML) systemParts.push(toolsXML);
  if (rules) systemParts.push(rules);
  if (format) systemParts.push(format);

  const systemPrompt = systemParts.join('\n\n');
  const messagePrompt = currentMessage;

  return { systemPrompt, messagePrompt };
}

// ========================================
// XML 解析器（栈式 + 智能补全）
// ========================================

function tokenizeXML(xml) {
  const tokens = [];
  let i = 0;

  while (i < xml.length) {
    if (xml[i] === '<') {
      if (xml.substr(i, 9) === '<![CDATA[') {
        tokens.push({ type: 'cdata_start' });
        i += 9;
      } else if (xml.substr(i, 3) === ']]>') {
        tokens.push({ type: 'cdata_end' });
        i += 3;
      } else if (xml[i + 1] === '/') {
        // 闭合标签
        const match = xml.substr(i).match(/^<\/(\w+)>/);
        if (match) {
          tokens.push({ type: 'close', name: match[1] });
          i += match[0].length;
        } else {
          i++;
        }
      } else {
        // 开始标签
        const match = xml.substr(i).match(/^<(\w+)([^>]*)>/);
        if (match) {
          const attrs = {};
          const attrRegex = /(\w+)="([^"]*)"/g;
          let attrMatch;
          while ((attrMatch = attrRegex.exec(match[2])) !== null) {
            attrs[attrMatch[1]] = attrMatch[2];
          }
          tokens.push({ type: 'open', name: match[1], attrs });
          i += match[0].length;
        } else {
          i++;
        }
      }
    } else {
      // 文本内容
      const nextTag = xml.indexOf('<', i);
      const text = nextTag === -1 ? xml.substr(i) : xml.substring(i, nextTag);
      if (text) {
        tokens.push({ type: 'text', text });
      }
      i = nextTag === -1 ? xml.length : nextTag;
    }
  }

  return tokens;
}

function parseToolCallsWithStack(xmlPart) {
  const toolCalls = [];
  const stack = [];
  let currentTool = null;
  let currentArgs = '';
  let inCDATA = false;

  const tokens = tokenizeXML(xmlPart);

  for (const token of tokens) {
    if (token.type === 'open' && token.name === 'tool_calls') {
      stack.push('tool_calls');
    } else if (token.type === 'open' && token.name === 'tool_call') {
      currentTool = {
        id: token.attrs.call_id || `toolu_${uuid().slice(0, 24)}`,
        name: token.attrs.name || '',
        input: null
      };
      stack.push('tool_call');
    } else if (token.type === 'open' && token.name === 'arguments') {
      stack.push('arguments');
      currentArgs = '';
    } else if (token.type === 'cdata_start') {
      inCDATA = true;
    } else if (token.type === 'cdata_end') {
      inCDATA = false;
    } else if (token.type === 'text' && stack[stack.length - 1] === 'arguments') {
      currentArgs += token.text;
    } else if (token.type === 'close' && token.name === 'arguments') {
      // 闭合 arguments
      try {
        currentTool.input = JSON.parse(currentArgs.trim());
      } catch (e) {
        // 简单修复：删除尾部逗号
        try {
          currentTool.input = JSON.parse(currentArgs.trim().replace(/,(\s*[}\]])/g, '$1'));
        } catch (e2) {
          currentTool.input = {};
        }
      }
      stack.pop();
    } else if (token.type === 'close' && token.name === 'tool_call') {
      // 智能补全：如果 arguments 还在栈中，自动闭合
      if (stack[stack.length - 1] === 'arguments') {
        try {
          currentTool.input = JSON.parse(currentArgs.trim());
        } catch (e) {
          try {
            currentTool.input = JSON.parse(currentArgs.trim().replace(/,(\s*[}\]])/g, '$1'));
          } catch (e2) {
            currentTool.input = {};
          }
        }
        stack.pop();
      }

      // 如果没有 input，补充空对象
      if (currentTool.input === null) {
        currentTool.input = {};
      }

      toolCalls.push(currentTool);
      currentTool = null;
      stack.pop();
    } else if (token.type === 'close' && token.name === 'tool_calls') {
      // 第一个 </tool_calls> 后立即停止
      stack.pop();
      break;
    }
  }

  // 流结束时的智能补全
  if (currentTool) {
    if (stack[stack.length - 1] === 'arguments') {
      try {
        currentTool.input = JSON.parse(currentArgs.trim());
      } catch (e) {
        currentTool.input = {};
      }
    }
    if (!currentTool.input) {
      currentTool.input = {};
    }
    toolCalls.push(currentTool);
  }

  return toolCalls;
}

function parseOutput(fullOutput) {
  const toolCallsStart = fullOutput.indexOf('<tool_calls');

  if (toolCallsStart === -1) {
    return {
      beforeText: fullOutput.trim(),
      toolCalls: []
    };
  }

  const beforeText = fullOutput.slice(0, toolCallsStart).trim();
  const xmlPart = fullOutput.slice(toolCallsStart);
  const toolCalls = parseToolCallsWithStack(xmlPart);

  return { beforeText, toolCalls };
}

// ========================================
// 响应生成器
// ========================================

function buildNonStreamResponse(beforeText, toolCalls, model) {
  const content = [];

  if (beforeText) {
    content.push({ type: 'text', text: beforeText });
  }

  for (const tc of toolCalls) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.input
    });
  }

  return {
    id: `msg_${uuid()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: estimateTokens(beforeText) + estimateTokens(JSON.stringify(toolCalls))
    }
  };
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function* chunkText(text, chunkSize) {
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
  }
}

async function* generateSSE(beforeText, toolCalls, model) {
  const msgId = `msg_${uuid()}`;
  let contentIndex = 0;

  // 1. message_start
  yield sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      usage: { input_tokens: 100, output_tokens: 1 }
    }
  });

  // 2. 文本块
  if (beforeText) {
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index: contentIndex,
      content_block: { type: 'text', text: '' }
    });

    for (const chunk of chunkText(beforeText, 15)) {
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: contentIndex,
        delta: { type: 'text_delta', text: chunk }
      });
      await sleep(10);
    }

    yield sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: contentIndex
    });

    contentIndex++;
  }

  // 3. 工具调用块
  for (const tool of toolCalls) {
    yield sseEvent('content_block_start', {
      type: 'content_block_start',
      index: contentIndex,
      content_block: {
        type: 'tool_use',
        id: tool.id,
        name: tool.name,
        input: {}
      }
    });

    const jsonStr = JSON.stringify(tool.input);
    for (const chunk of chunkText(jsonStr, 20)) {
      yield sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: contentIndex,
        delta: { type: 'input_json_delta', partial_json: chunk }
      });
      await sleep(8);
    }

    yield sseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: contentIndex
    });

    contentIndex++;
  }

  // 4. message_delta + message_stop
  yield sseEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      stop_sequence: null
    },
    usage: { output_tokens: 200 }
  });

  yield sseEvent('message_stop', {
    type: 'message_stop'
  });
}

// ========================================
// Express 应用
// ========================================

const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

// Claude Models API
app.get('/v1/models', (req, res) => {
  // 返回两个端点都支持的模型列表（交集），使用 Claude 格式
  const models = [
    // Premium models (10x rate)
    {
      id: 'anthropic/claude-3.7-sonnet',
      type: 'model',
      display_name: 'Claude 3.7 Sonnet',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'anthropic/claude-3.5-sonnet',
      type: 'model',
      display_name: 'Claude 3.5 Sonnet',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'anthropic/claude-3-5-haiku',
      type: 'model',
      display_name: 'Claude 3.5 Haiku',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'anthropic/claude-3-haiku',
      type: 'model',
      display_name: 'Claude 3 Haiku',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'openai/gpt-4o',
      type: 'model',
      display_name: 'GPT-4o',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'openai/gpt-4o-mini',
      type: 'model',
      display_name: 'GPT-4o Mini',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'openai/gpt-4.1',
      type: 'model',
      display_name: 'GPT-4.1',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'openai/gpt-5-chat',
      type: 'model',
      display_name: 'GPT-5 Chat',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'openai/gpt-5-mini',
      type: 'model',
      display_name: 'GPT-5 Mini',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'openai/gpt-5-nano',
      type: 'model',
      display_name: 'GPT-5 Nano',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'openai/o3',
      type: 'model',
      display_name: 'O3',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'google/gemini-pro-1.5',
      type: 'model',
      display_name: 'Gemini Pro 1.5',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'google/gemini-2.5-pro',
      type: 'model',
      display_name: 'Gemini 2.5 Pro',
      created_at: '2024-01-01T00:00:00Z'
    },
    // Standard models
    {
      id: 'google/gemini-flash-1.5',
      type: 'model',
      display_name: 'Gemini Flash 1.5',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'google/gemini-flash-1.5-8b',
      type: 'model',
      display_name: 'Gemini Flash 1.5 8B',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'google/gemini-2.0-flash-001',
      type: 'model',
      display_name: 'Gemini 2.0 Flash',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'google/gemini-2.5-flash',
      type: 'model',
      display_name: 'Gemini 2.5 Flash',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'google/gemini-2.5-flash-lite',
      type: 'model',
      display_name: 'Gemini 2.5 Flash Lite',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'meta-llama/llama-3.2-1b-instruct',
      type: 'model',
      display_name: 'Llama 3.2 1B',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'meta-llama/llama-3.2-3b-instruct',
      type: 'model',
      display_name: 'Llama 3.2 3B',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'meta-llama/llama-3.1-8b-instruct',
      type: 'model',
      display_name: 'Llama 3.1 8B',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'meta-llama/llama-3.1-70b-instruct',
      type: 'model',
      display_name: 'Llama 3.1 70B',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'meta-llama/llama-4-maverick',
      type: 'model',
      display_name: 'Llama 4 Maverick',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'meta-llama/llama-4-scout',
      type: 'model',
      display_name: 'Llama 4 Scout',
      created_at: '2024-01-01T00:00:00Z'
    },
    {
      id: 'openai/gpt-oss-120b',
      type: 'model',
      display_name: 'GPT OSS 120B',
      created_at: '2024-01-01T00:00:00Z'
    }
  ];

  res.json({
    data: models,
    has_more: false,
    first_id: models.length > 0 ? models[0].id : null,
    last_id: models.length > 0 ? models[models.length - 1].id : null
  });
});

app.post('/v1/messages', async (req, res) => {
  const requestId = `req-${uuid().slice(0, 16)}`;

  try {
    // 提取 API Key
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

    if (!apiKey) {
      console.log(`[${requestId}] ❌ 缺少 API Key`);
      return res.status(401).json({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Missing API key. Please provide x-api-key header or Authorization: Bearer <key>'
        }
      });
    }

    const { model, messages, system, tools, stream, max_tokens } = req.body;

    if (!messages || !Array.isArray(messages)) {
      console.log(`[${requestId}] ❌ 无效请求: messages 字段缺失或格式错误`);
      return res.status(400).json({ error: 'messages is required and must be an array' });
    }

    // 应用模型映射
    const requestModel = model || 'google/gemini-2.5-flash-lite';
    const actualModel = mapModel(requestModel);

    console.log(`\n${'='.repeat(80)}`);
    console.log(`[${requestId}] 📥 收到请求`);
    console.log(`[${requestId}] 请求模型: ${requestModel}`);
    if (requestModel !== actualModel) {
      console.log(`[${requestId}] 实际模型: ${actualModel} (已映射)`);
    }
    console.log(`[${requestId}] Messages: ${messages.length} 条`);
    console.log(`[${requestId}] Tools: ${tools ? tools.length : 0} 个`);
    console.log(`[${requestId}] Stream: ${stream ? '是' : '否'}`);
    console.log(`[${requestId}] 完整请求体:\n${JSON.stringify(req.body, null, 2)}`);

    // 1. 构建 prompt
    const { systemPrompt, messagePrompt } = buildPrompt(messages, system, tools);

    console.log(`\n[${requestId}] 🔧 Prompt 转换完成`);
    console.log(`[${requestId}] system_prompt 长度: ${systemPrompt.length} 字符`);
    console.log(`[${requestId}] message_prompt 长度: ${messagePrompt.length} 字符`);
    console.log(`[${requestId}] system_prompt:\n${systemPrompt.slice(0, 500)}${systemPrompt.length > 500 ? '...(截断)' : ''}`);
    console.log(`[${requestId}] message_prompt:\n${messagePrompt.slice(0, 300)}${messagePrompt.length > 300 ? '...(截断)' : ''}`);

    // 2. 选择端点
    const endpoint = (systemPrompt.length > 5000 || messagePrompt.length > 5000)
      ? "fal-ai/any-llm/enterprise"
      : "fal-ai/any-llm";

    console.log(`\n[${requestId}] 🎯 端点选择: ${endpoint}`);
    console.log(`[${requestId}] 原因: system=${systemPrompt.length}, message=${messagePrompt.length}`);

    // 3. 调用 fal (为每个请求配置 key)
    console.log(`[${requestId}] 🚀 调用上游 fal.ai...`);
    console.log(`[${requestId}] 使用模型: ${actualModel}`);

    // 配置 credentials
    fal.config({ credentials: apiKey });

    const result = await fal.subscribe(endpoint, {
      input: {
        prompt: messagePrompt,
        system_prompt: systemPrompt,
        model: actualModel,
        max_tokens: max_tokens || 8192
      }
    });

    const fullOutput = result.data.output;
    console.log(`\n[${requestId}] ✅ 上游返回成功`);
    console.log(`[${requestId}] 输出长度: ${fullOutput.length} 字符`);
    console.log(`[${requestId}] 完整输出:\n${fullOutput}`);

    // 4. 解析输出
    const { beforeText, toolCalls } = parseOutput(fullOutput);

    console.log(`\n[${requestId}] 🔍 解析结果`);
    console.log(`[${requestId}] 文本内容: ${beforeText.length} 字符`);
    console.log(`[${requestId}] 工具调用: ${toolCalls.length} 个`);
    if (beforeText) {
      console.log(`[${requestId}] 文本: ${beforeText.slice(0, 200)}${beforeText.length > 200 ? '...' : ''}`);
    }
    if (toolCalls.length > 0) {
      console.log(`[${requestId}] 工具调用详情: ${JSON.stringify(toolCalls, null, 2)}`);
    }

    // 5. 返回响应 (响应中保留原始请求的模型名)
    if (stream) {
      console.log(`[${requestId}] 📤 开始流式输出...`);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let chunkCount = 0;
      for await (const chunk of generateSSE(beforeText, toolCalls, requestModel)) {
        chunkCount++;
        console.log(`[${requestId}] 📦 流式块 #${chunkCount}: ${chunk.slice(0, 100).replace(/\n/g, '\\n')}...`);
        res.write(chunk);
      }
      res.end();
      console.log(`[${requestId}] ✅ 流式输出完成，共 ${chunkCount} 个块`);
    } else {
      const response = buildNonStreamResponse(beforeText, toolCalls, requestModel);
      console.log(`[${requestId}] 📤 返回非流式响应`);
      console.log(`[${requestId}] 响应体:\n${JSON.stringify(response, null, 2)}`);
      res.json(response);
      console.log(`[${requestId}] ✅ 非流式输出完成`);
    }

    console.log(`${'='.repeat(80)}\n`);
  } catch (error) {
    console.error(`[${requestId}] ❌ 错误:`, error);
    console.error(`[${requestId}] 错误堆栈:\n${error.stack}`);
    res.status(500).json({
      type: 'error',
      error: {
        type: 'internal_error',
        message: error.message
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Fal2Claude 服务启动在 http://localhost:${PORT}`);
  console.log(`   健康检查: http://localhost:${PORT}/healthz`);
  console.log(`   模型列表: http://localhost:${PORT}/v1/models`);
  console.log(`   API 端点: http://localhost:${PORT}/v1/messages`);
});