// StructureView.tsx — 只读结构视图（节点图）：输入依赖与剪辑顺序。按需懒加载，ReactFlow 不进首屏包。
import { useEffect, useMemo, useRef } from 'react';
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, useNodesState, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AudioLines, Clapperboard, Layers3, Lock } from 'lucide-react';
import { projectFile, type ProjectShot, type ProjectTransition, type VideoProject } from './api';
import { transitionLabels } from './TransitionInspector';
import { analysisSourceLabel, sourceLabel, statusLabel } from './labels';

type ShotNode = Node<{ shot: ProjectShot; projectId: string; index: number } & Record<string, unknown>, 'project-shot'>;
type TransitionNode = Node<{ transition: ProjectTransition; fromTitle: string; toTitle: string } & Record<string, unknown>, 'project-transition'>;
type ContextNode = Node<{ title: string; detail: string; kind: string } & Record<string, unknown>, 'project-context'>;

function ShotNodeView({ data, selected }: NodeProps<ShotNode>) {
  const shot = data.shot;
  return <div className={`studio-node project-shot-node ${selected ? 'is-selected' : ''}`} title={`${shot.title} · ${shot.start.toFixed(3)}–${shot.end.toFixed(3)}s · 输入 v${shot.inputRevision}`}>
    <div className="node-header"><Clapperboard size={14} /><div className="node-heading"><span className="node-eyebrow">镜头 {String(data.index + 1).padStart(2, '0')} · {shot.id}</span><strong>{shot.title}</strong></div>{shot.locked && <Lock size={13} />}</div>
    <div className="node-body">
      {shot.validation ? <img src={projectFile(data.projectId, `artifacts/${shot.validation.thumb}`)} alt={`${shot.title} 已验证静帧`} /> : <div className="project-thumb-empty"><Clapperboard size={25} /><span>真实场景 · 等待渲染</span></div>}
      <div className="project-shot-status">{shot.status === 'ready' ? '✓ ' : '○ '}{statusLabel[shot.status] ?? shot.status}</div>
      <div className="project-shot-time">{shot.start.toFixed(2)}–{shot.end.toFixed(2)}s · v{shot.inputRevision}</div>
    </div>
    <div className="node-footer"><span>{sourceLabel(shot.source)}</span><span>SCENE</span></div>
    <Handle type="target" position={Position.Left} id="input" /><Handle type="target" position={Position.Right} id="feedback" style={{ top: '25%' }} /><Handle type="source" position={Position.Right} id="output" style={{ top: '75%' }} />
  </div>;
}
function ContextNodeView({ data }: NodeProps<ContextNode>) {
  return <div className="studio-node project-context-node"><div className="node-header">{data.kind === 'audio' ? <AudioLines size={16} /> : <Layers3 size={16} />}<strong>{data.title}</strong></div><div className="node-body">{data.detail}</div>
    {data.kind !== 'audio' && <Handle type="target" position={Position.Left} />}{data.kind !== 'output' && <Handle type="source" position={Position.Right} />}</div>;
}
function TransitionNodeView({ data, selected }: NodeProps<TransitionNode>) {
  const tr = data.transition;
  return <div className={`studio-node project-transition-node ${selected ? 'is-selected' : ''}`}>
    <div className="node-header"><Layers3 size={14} /><strong>转场 / {transitionLabels[tr.mode]}</strong>{tr.locked && <Lock size={12} />}</div>
    <div className="node-body"><small>{data.fromTitle} → {data.toTitle}</small><p>{tr.intent}</p><span>{tr.mode === 'cut' ? '节拍硬切' : `${tr.duration.toFixed(2)}s`} · v{tr.inputRevision}{tr.feedback?.length ? ` · ${tr.feedback.length} 条意见` : ''}</span></div>
    <Handle type="target" position={Position.Left} id="from" style={{ top: '30%' }} /><Handle type="target" position={Position.Left} id="to" style={{ top: '70%' }} /><Handle type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { 'project-shot': ShotNodeView, 'project-context': ContextNodeView, 'project-transition': TransitionNodeView };

export default function StructureView({ project, selectedId, selectedTransitionId, focus, onSelectShot, onSelectTransition }: {
  project: VideoProject; selectedId: string | null; selectedTransitionId: string | null;
  /** 侧栏点击时要聚焦的节点 id；节点图内的点击不聚焦。 */
  focus: { id: string; nonce: number } | null;
  onSelectShot: (id: string) => void; onSelectTransition: (id: string) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const flow = useRef<ReactFlowInstance | null>(null);
  useEffect(() => {
    const contexts: ContextNode[] = [
      { id: 'bgm', type: 'project-context', position: { x: 0, y: 120 }, data: { title: 'BGM / 输入', detail: project.audio.name, kind: 'audio' } },
      { id: 'analysis', type: 'project-context', position: { x: 280, y: 120 }, data: { title: '词级 / 节拍 / 段落', detail: `${analysisSourceLabel(project)}。${project.analysis.note ?? ''}`, kind: 'analysis' } },
      { id: 'output', type: 'project-context', position: { x: 2900, y: 760 }, data: { title: '全片 / MP4', detail: '冻结工程 → 分段缓存 → 全曲 BGM 封装', kind: 'output' } },
    ];
    const shots: ShotNode[] = project.shots.map((shot, index) => ({ id: `shot-${shot.id}`, type: 'project-shot', selected: shot.id === selectedId,
      position: { x: 610 + (index % 4) * 560, y: Math.floor(index / 4) * 520 }, data: { shot, index, projectId: project.id } }));
    const transitions: TransitionNode[] = (project.transitions ?? []).map((transition, index) => ({
      id: `transition-${transition.id}`, type: 'project-transition', selected: transition.id === selectedTransitionId,
      position: { x: 610 + (index % 4) * 560, y: Math.floor(index / 4) * 520 + 320 },
      data: { transition, fromTitle: project.shots.find((shot) => shot.id === transition.fromShotId)?.title ?? transition.fromShotId,
        toTitle: project.shots.find((shot) => shot.id === transition.toShotId)?.title ?? transition.toShotId },
    }));
    setNodes((previous) => {
      const existing = new Map(previous.map((node) => [node.id, node]));
      return [...contexts, ...shots, ...transitions].map((node) => ({ ...existing.get(node.id), ...node, position: existing.get(node.id)?.position ?? node.position }));
    });
  }, [project, selectedId, selectedTransitionId, setNodes]);
  const edges: Edge[] = useMemo(() => [
    { id: 'bgm-analysis', source: 'bgm', target: 'analysis' },
    ...project.shots.flatMap((shot) => [
      { id: `in-${shot.id}`, source: 'analysis', target: `shot-${shot.id}`, targetHandle: 'input' },
      { id: `out-${shot.id}`, source: `shot-${shot.id}`, sourceHandle: 'output', target: 'output' },
    ]),
    ...(project.transitions ?? []).flatMap((transition) => [
      { id: `tr-from-${transition.id}`, source: `shot-${transition.fromShotId}`, sourceHandle: 'output', target: `transition-${transition.id}`, targetHandle: 'from' },
      { id: `tr-to-${transition.id}`, source: `shot-${transition.toShotId}`, sourceHandle: 'output', target: `transition-${transition.id}`, targetHandle: 'to' },
      { id: `tr-out-${transition.id}`, source: `transition-${transition.id}`, target: 'output' },
    ]),
  ], [project]);
  useEffect(() => {
    if (focus) void flow.current?.fitView({ nodes: [{ id: focus.id }], maxZoom: 1, padding: 0.4, duration: 220 });
  }, [focus]);
  return <ReactFlow key={project.id} nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onInit={(instance) => { flow.current = instance; }}
    onNodeClick={(_, node) => { if (node.id.startsWith('shot-')) onSelectShot(node.id.slice(5)); else if (node.type === 'project-transition') onSelectTransition(node.id.slice('transition-'.length)); }} fitView minZoom={0.18} maxZoom={1.4} fitViewOptions={{ padding: 0.12 }} deleteKeyCode={null} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
    <Background gap={24} size={1} /><Controls showInteractive={false} /><MiniMap />
  </ReactFlow>;
}
