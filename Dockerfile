# 后端容器化部署（配合 Render / Railway / Fly.io 等免费/低价容器托管）
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY backend/ ./backend/
COPY frontend/ ./frontend/
EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
CMD ["node", "backend/server.js"]
