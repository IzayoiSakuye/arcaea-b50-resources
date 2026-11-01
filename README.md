# Arcaea Best50 资源构建

用于获取曲库、视频索引、曲绘和背景图，并打包为资源文件。

## 环境要求

- Node.js 23.6 或更高版本
- `ffmpeg` 和 `tar` 可在命令行中使用
- 构建时需要联网；运行脚本无需安装 npm 依赖

## 构建资源

在项目根目录运行，版本号按实际发布日期填写：

```powershell
node scripts/build-release.ts --version 2026.11.01
```

脚本会刷新数据、生成资源包并校验。完成后，文件位于 `dist/`：

- `arcaea-data-<版本>.zip`：资源包
- `latest.json`：版本和文件清单

如果只想用已有的 `data/` 重新打包：

```powershell
node scripts/build-release.ts --version 2026.11.01 --pack-only
```

发布时，在 GitHub Releases 创建标签 `data-<版本>` 的正式 Release，上传上述两个文件。
