import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorApp } from './EditorApp';
import '../popup/styles.css';
import './editor.css';

const el = document.getElementById('root');
if (!el) throw new Error('QA Reporter editor: #root missing');
createRoot(el).render(
  <StrictMode>
    <EditorApp />
  </StrictMode>,
);
