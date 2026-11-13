import React from 'react';
import { createRoot } from 'react-dom/client';
import { Playground } from './Playground';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<Playground />);
}
