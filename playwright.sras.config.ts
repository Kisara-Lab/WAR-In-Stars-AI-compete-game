import base from './playwright.config.js';
import { defineConfig } from '@playwright/test';
export default defineConfig({...base,testMatch:'sras.spec.ts',use:{...base.use,baseURL:'http://127.0.0.1:8792'},webServer:{command:'node scripts/serve-isolated.mjs --build dist --data .data/sras-browser --port 8792',url:'http://127.0.0.1:8792/api/health',reuseExistingServer:false}});
