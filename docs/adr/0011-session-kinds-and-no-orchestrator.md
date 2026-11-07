# 会话类型只有四种，删除 orchestrator

用户 2026-11-07 决定取消「主代理只能 dispatch」的缴械限制与独立的编排会话。会话类型收敛为 master / worker / inspector / reporter 四种，orchestrator 作为类型与词汇一并删除。

原因：编排会话与主对话分裂成两个身份位，导致「谁在派发、谁在盯」两边都要维护，且用户无法在编排会话跑着时插手。

状态：接受。取代 ADR 0010 的决定 1（Master 与 orchestrator 两槽互斥）。
