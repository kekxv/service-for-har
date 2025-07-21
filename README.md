# service-for-har

## 快速使用 (quick use)

```shell
npx service-for-har
```

## 简介

`service-for-har` 是一个用于处理 HAR（HTTP Archive）文件的服务。它可以解析 HAR 文件，并提供相关的 API 或服务，方便开发者进行 HTTP 请求数据的分析与复现。

## 特性

- 解析 HAR 文件
- 提供 API 服务
- 支持自定义扩展

## 快速开始

1. 安装依赖

```bash
pnpm install
```

2. 启动服务


### 方式一：npx 一键运行

```bash
npx service-for-har [har文件或目录路径]
```

### 方式二：本地安装依赖

```bash
pnpm install
pnpm run build
pnpm start
```

你可以在 `example/example.har` 文件中找到示例 HAR 文件。
```bash
pnpm start
```

3. 示例

你可以在 `example/example.har` 文件中找到示例 HAR 文件。

## 目录结构

```
.
├── LICENSE
├── package.json

### Method 1: Run directly with npx

```bash
npx service-for-har [path-to-har-file-or-directory]
```

### Method 2: Local install

```bash
pnpm install
pnpm run build
pnpm start
```

You can find a sample HAR file in `example/example.har`.
├── pnpm-lock.yaml
├── tsconfig.json

## 自动发布

本项目已配置 GitHub Actions，推送到 main 分支会自动发布到 npm（需配置 NPM_TOKEN）。
├── example/
│   └── example.har

## Auto Publish

This project uses GitHub Actions to auto-publish to npm on push to main (NPM_TOKEN required).

## License

This project is licensed under the MIT License.
└── src/
    └── server.ts
```

## 许可证

本项目采用 MIT 许可证。

---

# service-for-har

## Introduction

`service-for-har` is a service for handling HAR (HTTP Archive) files. It can parse HAR files and provide related APIs or services, making it easy for developers to analyze and replay HTTP request data.

## Features

- Parse HAR files
- Provide API services
- Support custom extensions

## Quick Start

1. Install dependencies

```bash
pnpm install
```

2. Start the service

```bash
pnpm start
```

3. Example

You can find a sample HAR file in `example/example.har`.

## Directory Structure

```
.
├── LICENSE
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── example/
│   └── example.har
└── src/
    └── server.ts
```

## License

This project is licensed under the MIT License.