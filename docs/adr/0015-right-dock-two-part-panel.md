# 右栏两段式面板

Master 面板落在右栏 dock：上段固定 Inspector 与 Reporter，下段是 worker 列表，点开的 worker 占一个页签；页签内是宿主完整会话视图，可直接输入。

原因：主区左右真分屏宿主没有设施（main 槽只认 conversation 一个 key），右栏 dock 支持多页签与浮动/全屏，且宿主 `dsh-client-ui-subagent` 的会话视图自带 InputBar。

状态：接受。推翻 ADR 0010 替代方案 6 的否决理由——当时否的是「塞进输入区右侧」这个座位，不是面板本身。
