import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="project-empty" role="alert">
      <h2>审阅室出现界面错误</h2>
      <pre className="song-stage-error">{this.state.error.message}</pre>
      <p>工程数据在本地服务中，不受影响。</p>
      <button className="action-button" onClick={() => location.reload()}>重新加载</button>
    </div>;
  }
}
