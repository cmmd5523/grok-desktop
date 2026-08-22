const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grokAPI', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  getConversation: (id) => ipcRenderer.invoke('conversations:get', id),
  saveConversation: (conv) => ipcRenderer.invoke('conversations:save', conv),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  listModels: () => ipcRenderer.invoke('models:list'),
  selectFiles: () => ipcRenderer.invoke('files:select'),
  compactChat: (payload) => ipcRenderer.invoke('chat:compact', payload),
  exportConversation: (conv) => ipcRenderer.invoke('conversation:export', conv),
  startChat: (payload) => ipcRenderer.invoke('chat:start', payload),
  stopChat: () => ipcRenderer.invoke('chat:stop'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authRegister: (payload) => ipcRenderer.invoke('auth:register', payload),
  authVerify: (payload) => ipcRenderer.invoke('auth:verify', payload),
  authLogin: (payload) => ipcRenderer.invoke('auth:login', payload),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  authConfig: () => ipcRenderer.invoke('auth:config'),
  reportUsage: (payload) => ipcRenderer.invoke('usage:report', payload),
  onChatDelta: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('chat:delta', listener);
    return () => ipcRenderer.removeListener('chat:delta', listener);
  },
});
