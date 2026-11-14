import {defineConfig} from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({...base,testMatch:['adaptive-v412.spec.ts','mixed.spec.ts'],use:{...base.use,baseURL:'http://127.0.0.1:8794'},webServer:{command:`node scripts/serve-isolated.mjs --port 8794 --build ${process.env.V412_BUILD??'.data/verification/adaptive-v412/development-runtime/dist'} --data ${process.env.V412_BROWSER_DATA??'.data/verification/adaptive-v412/development-browser'} --strategy adaptive-v4.12`,url:'http://127.0.0.1:8794/api/health',reuseExistingServer:false}});
