# Prepare with pnpm verify && pnpm package:context; build .artifacts/context.
FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS dependencies
WORKDIR /app
RUN npm install --global pnpm@10.29.2
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 OPS_HOST=127.0.0.1 OPS_PORT=3001
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node dist ./dist
COPY --chown=node:node assets/auth ./assets/auth
COPY --chown=node:node openapi ./openapi
USER node
RUN node --input-type=module -e 'import {PasswordService} from "./dist/modules/auth/password.service.js"; import {createApp} from "./dist/app.js"; const service=new PasswordService(); const password="Synthetic image smoke 123!"; if(!await service.verify(await service.hash(password),password)||typeof createApp!=="function") process.exit(1);'
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "--input-type=module", "-e", "try{const host=process.env.OPS_HOST||'127.0.0.1';const address=host.includes(':')?'['+host+']':host;const response=await fetch('http://'+address+':'+process.env.OPS_PORT+'/_ops/live',{signal:AbortSignal.timeout(3000)});process.exit(response.ok?0:1)}catch{process.exit(1)}"]
CMD ["node", "dist/main.js"]
