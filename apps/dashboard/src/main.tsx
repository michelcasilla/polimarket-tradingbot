import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#16c784',
          borderRadius: 8,
          fontSize: 12,
          fontSizeSM: 11,
        },
        components: {
          Card: {
            paddingSM: 0,
            paddingMD: 0,
            paddingLG: 0,
            padding: 0,
            bodyPadding: 0,
          },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
