FROM node:20-alpine

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖
RUN npm ci --production

# 复制源代码
COPY index.js ./

# 暴露端口
EXPOSE 8080

# 启动应用
CMD ["node", "index.js"]