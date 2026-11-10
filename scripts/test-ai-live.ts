if(process.env['LLM_MODE']!=='hosted'){await (await import('./test-ai-native.ts')).runNative();}else{await import('./test-ai-full.ts');}
