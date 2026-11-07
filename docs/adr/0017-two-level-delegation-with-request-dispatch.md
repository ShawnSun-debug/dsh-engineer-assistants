# 两层派发与申请制

派发深度最多两层：worker 可以再派一层子 worker，子 worker 不能再派。只有「确定动代码」的预设（implementer / debugger / refactorer / operator）可以发起 request_dispatch，请求阻塞等待 Master 批准，10 分钟超时自动驳回并告知用户。

原因：用户要求「允许但必须确认值不值得」，且面板与监工要能看清归属。
