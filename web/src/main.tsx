import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { CurriculumProvider } from './store/curriculum.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  /**
   * CurriculumProvider —— 知识体系（服务端资产）的全局提供者。
   *
   * 分离后前端不再硬编码 589 行知识本体，改为从
   * GET /api/v1/knowledge-points 拉取并缓存。
   */
  <CurriculumProvider>
    <App />
  </CurriculumProvider>
);
