# service-for-har

一个用于解析和复现 HAR（HTTP Archive）文件的服务，支持 API 调用和自定义扩展，帮助开发者高效分析 HTTP 请求数据。

---

## 特性 Features

- 🚀 解析 HAR 文件，提取 HTTP 请求数据
- 🛠️ 提供 API 服务，便于集成和自动化
- 🔌 支持自定义扩展，满足个性化需求
- 📦 一键运行，快速上手

---

## 快速开始 Quick Start

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动服务

#### 方法一：npx 一键运行

无需全局安装，直接运行：

```bash
npx service-for-har [har文件或目录路径] [参数]
```

#### 方法二：本地安装依赖

适合本地开发和二次开发：

```bash
pnpm install
pnpm run build
pnpm start -- [参数]
```

### 3. 示例 HAR 文件

你可以在 [`example/example.har`](example/example.har) 找到示例 HAR 文件，方便测试和体验。

---

## 参数说明 Parameters

- `--path <har文件或目录路径>`  
  指定要加载的 HAR 文件或目录路径。默认读取当前目录下的 `./har_storage`。

- `--port <端口号>`  
  指定服务启动的端口号，默认端口为 `3000`。  
  例如：`npx service-for-har --port 8080`

---

## 目录结构 Directory Structure

```
.
├── LICENSE
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── example/
│   └── example.har
├── har_storage/
└── src/
    └── server.ts
```

---

## 许可证 License

Apache License

---

## English Introduction

`service-for-har` is a service for handling HAR (HTTP Archive) files. It can parse HAR files, provide related APIs, and support custom extensions, making it easy for developers to analyze and replay HTTP request data.

### Features

- Parse HAR files
- Provide API services
- Support custom extensions
- Easy to use

### Quick Start

1. Install dependencies

    ```bash
    pnpm install
    ```

2. Start the service

    ```bash
    pnpm start
    ```

3. Example HAR file: [`example/example.har`](example/example.har)

### Parameters

- `--path <path-to-har-file-or-directory>`  
  Specify the HAR file or directory to load. Defaults to `./har_storage`.

- `--port <port>`  
  Specify the port for the service (default: `3000`).  
  Example: `npx service-for-har --port 8080`

---

欢迎提出建议或贡献代码！如有问