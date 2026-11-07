# 角色预设由插件自管

十套角色预设的工具面、system prompt 与模型档位由插件自己施加：在 agent/created 钩子里对子代理 restrict 并注入 prompt 段，自建登记表记 sessionId → presetId；冷恢复时由插件重放。

原因：宿主的 startActivation 入参没有 toolFilter / persona，composition 只在冷恢复时从 descriptor 回填，全新启动只带 agentPreset。走宿主 Agent Preset 虽然能自动重放，但十套预设要写成 Cordis 行清单，运行时编辑与校验都受限。

代价：冷恢复重放由插件负责，漏了就退化成「工具没限住」；模型可见工具面还要单独裁一次。
