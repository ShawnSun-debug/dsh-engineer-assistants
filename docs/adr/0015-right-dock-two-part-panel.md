# 右栏两段式面板

面板落在右栏 dock：上段固定 **Master、Inspector 与 Reporter** 三个常驻入口，下段是 worker 列表，点开的 worker 占一个页签；页签内是宿主完整会话视图，可直接输入。

（2026-11-08 更正：原写「Inspector 与 Reporter」两项，漏了常驻 master。master 是常驻会话、无工作区，由插件一键生成或设置面板指定；三个固定入口不带 session，master 指向哪个会话作为一条独立事实暴露。）

原因：主区左右真分屏宿主没有设施（main 槽只认 conversation 一个 key），右栏 dock 支持多页签与浮动/全屏，且宿主 `dsh-client-ui-subagent` 的会话视图自带 InputBar。

worker 页签不必自己画会话：宿主已有 `SidebarChat`（`dsh-client-ui-subagent` 的 `registerSidebarChat`），认 `dsh-resource://subagentchat/session/<child>?parent=…&mode=…` 这一种资源地址。我们只拼地址、调 `sidebarRight.openResource`，页签与视图都归宿主。

状态：接受。推翻 ADR 0010 替代方案 6 的否决理由——当时否的是「塞进输入区右侧」这个座位，不是面板本身。
