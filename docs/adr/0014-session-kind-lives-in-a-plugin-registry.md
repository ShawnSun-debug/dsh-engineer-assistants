# 会话类型存插件登记表

四种类型与派发归属存在插件自建的持久登记表里，不入宿主 Session header。

原因：Session header 无扩展字段（origin 只允许 'subagent'），startActivation 不接受自定义 meta，subagent descriptor 的键封闭、多一个字段直接抛错。

做法：先用 spec.childId 预占 sessionId，再把登记行写进去，保证登记与创建对齐。
