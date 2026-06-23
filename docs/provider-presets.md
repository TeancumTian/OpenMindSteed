# Provider Presets

OpenMindSteed BYOK Direct uses OpenAI-compatible `/chat/completions` streaming. Presets only fill endpoint and default model values; users still bring their own API key, and keys are stored through the OS keychain in the Tauri desktop app.

## Current Presets

| Preset                   | Endpoint                                                 | Default model       | Web search adapter                   | Image adapter               | Notes                                                                                                                                          |
| ------------------------ | -------------------------------------------------------- | ------------------- | ------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom OpenAI-compatible | user supplied                                            | user supplied       | none                                 | none                        | For local gateways, proxies, and unlisted providers.                                                                                           |
| DeepSeek                 | `https://api.deepseek.com`                               | `deepseek-v4-flash` | none                                 | none                        | OpenAI-compatible chat endpoint.                                                                                                               |
| Qwen / DashScope Global  | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen-plus`         | `enable_search`                      | none                        | Singapore/global endpoint. API keys differ by region.                                                                                          |
| Qwen / DashScope China   | `https://dashscope.aliyuncs.com/compatible-mode/v1`      | `qwen-plus`         | `enable_search`                      | none                        | China Beijing endpoint.                                                                                                                        |
| Z.AI / Zhipu GLM         | `https://api.z.ai/api/paas/v4`                           | `glm-5.2`           | `web_search` tool                    | `glm-image` sync generation | General API endpoint, not the Coding Plan endpoint.                                                                                            |
| Kimi / Moonshot          | `https://api.moonshot.ai/v1`                             | `kimi-k2.6`         | builtin `$web_search` tool-call loop | none                        | Global OpenAI-compatible endpoint. Web search uses Kimi's built-in function and returns the final answer after the tool loop completes.        |
| Doubao / Volcengine Ark  | `https://ark.cn-beijing.volces.com/api/v3`               | user supplied       | Responses `web_search`               | none                        | Ark model ids depend on enabled inference endpoints in the user's console. Web search uses `/responses`; normal chat uses `/chat/completions`. |

## Limits

- Web search is implemented for Qwen/DashScope, Z.AI GLM, Kimi/Moonshot, and Doubao/Volcengine Ark. Kimi `$web_search` uses a non-streaming tool-call loop before emitting the final answer into the chat stream. Doubao Web Search uses Ark's Responses API with `tools: [{"type":"web_search"}]`, then returns to the Chat Completions path for title/summary/suggestion extraction.
- Image generation is implemented only for the Z.AI `glm-image` synchronous API. In Tauri desktop builds, returned URLs are downloaded into local app data under `generated-images/` and rendered through Tauri's asset protocol. Browser preview keeps the provider URL.
- Additional Responses API variants are not implemented yet.
- Editing endpoint or model manually switches the preset back to `Custom OpenAI-compatible`.
- The generic BYOK adapter expects Server-Sent Events in OpenAI chat-completions format.
- Provider docs and available model ids can change, so presets are convenience defaults, not a guarantee that every account can call the listed model.

## Source Pages

- DeepSeek API Docs: https://api-docs.deepseek.com/
- Alibaba Cloud Model Studio OpenAI-compatible Qwen chat docs: https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions
- Z.AI Web Search guide: https://docs.z.ai/guides/tools/web-search
- Z.AI Chat Completion API reference: https://docs.z.ai/api-reference/llm/chat-completion
- Z.AI Generate Image API reference: https://docs.z.ai/api-reference/image/generate-image
- Kimi API overview: https://platform.kimi.ai/docs/api/overview
- Kimi web search guide: https://platform.kimi.ai/docs/guide/use-web-search
- Volcengine Ark OpenAI-compatible docs: https://www.volcengine.com/docs/82379/1330626
- Volcengine Ark Web Search docs: https://www.volcengine.com/docs/82379/1338552
- Volcengine Ark Responses streaming docs: https://www.volcengine.com/docs/82379/1599499
