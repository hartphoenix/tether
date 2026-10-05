import { buildWeb } from '../src/web/build';
await buildWeb(process.argv[2] ?? 'dist');
