import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({...base,testMatch:'adaptive-v41.spec.ts',use:{...base.use,baseURL:'http://127.0.0.1:8792'},webServer:{command:'node scripts/serve-isolated.mjs --port 8792 --data .data/verification/adaptive-v41/browser',url:'http://127.0.0.1:8792/api/health',reuseExistingServer:false}});
