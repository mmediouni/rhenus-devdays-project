FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8787 URD_STORAGE=local URD_STORAGE_DIR=/data
VOLUME /data
EXPOSE 8787
CMD ["node", "src/standalone.js"]
