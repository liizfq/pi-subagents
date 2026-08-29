/**
 * pi-subagents 入口包装（重命名显示名：src -> subagents）。
 *
 * 显示名由入口文件路径推导：目录 + index.ts -> 目录名。
 * 原入口为 src/index.ts（显示 "src"），本包装改为 subagents/index.ts（显示 "subagents"）。
 */
export { default } from "../src/index.ts";
