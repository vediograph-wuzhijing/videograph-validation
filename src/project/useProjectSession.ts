import { useCallback, useEffect, useRef, useState } from 'react';
import { projectApi, ProjectApiError } from './api';
import type { VideoProject, ProjectSummary, ProjectJob, DirectorSnapshot, DirectorLoadState } from './contracts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useProjectSession(onLoad: (project: VideoProject) => void, onError: (error: unknown) => void) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<VideoProject | null>(null);
  const [jobs, setJobs] = useState<ProjectJob[]>([]);
  const [directorState, setDirectorState] = useState<DirectorLoadState>({ projectId: '', status: 'absent' });
  const [pollError, setPollError] = useState('');
  const [serviceWarning, setServiceWarning] = useState('');
  const loadEpoch = useRef(0);
  const directorStale = useRef(false);
  const activeProjectId = useRef<string | null>(null);
  const onLoadRef = useRef(onLoad), onErrorRef = useRef(onError);
  onLoadRef.current = onLoad; onErrorRef.current = onError;
  const refreshList = useCallback(async () => {
    const data = await projectApi<{ projects: ProjectSummary[] }>('/projects'); setProjects(data.projects); return data.projects;
  }, []);
  const load = useCallback(async (id: string) => {
    const epoch = ++loadEpoch.current;
    const data = await projectApi<VideoProject>(`/projects/${id}`);
    if (epoch !== loadEpoch.current) return;
    activeProjectId.current = id;
    setProject(data); setJobs([]); onLoadRef.current(data);
    setDirectorState({ projectId: id, status: 'loading' });
    history.replaceState(null, '', `?view=project&project=${encodeURIComponent(id)}`);
  }, []);
  useEffect(() => {
    void refreshList().then((list) => {
      const id = new URLSearchParams(location.search).get('project');
      if (id && list.some((entry) => entry.id === id)) return load(id);
      if (list[0]) return load(list[0].id);
    }).catch((err) => onErrorRef.current(err));
  }, [load, refreshList]);

  useEffect(() => {
    if (!project) return;
    let stopped = false, polling = false;
    let projectVersion = -1, jobsVersion = -1;
    const id = project.id;
    const tick = async () => {
      if (polling) return; polling = true;
      try {
        const version = await projectApi<{revision: number; jobsVersion: number}>(`/projects/${id}/version`);
        const health = await projectApi<{codeStale?: boolean; database?: {largestBytes: number}; queued?: number; operationsQueued?: number;storageMigration?:{state:string;completed:number;total:number}}>('/health');
        if (!stopped) setServiceWarning(health.codeStale ? '服务代码已更新：当前仍运行旧版本，请在后台任务完成后重启服务。'
          : health.storageMigration?.state==='running'?`正在迁移工程存储 ${health.storageMigration.completed}/${health.storageMigration.total}，健康检查与审阅室保持可用。`
          : health.storageMigration?.state==='incomplete'?'部分工程存储迁移失败，请查看服务日志并运行存储检查。'
          : (health.operationsQueued ?? 0) > 16 ? '服务操作队列积压，正在处理。' : '');
        const changedProject = projectVersion !== version.revision;
        const changedJobs = jobsVersion !== version.jobsVersion;
        const [currentResult, jobResult, directorResult] = await Promise.allSettled([
          changedProject ? projectApi<VideoProject>(`/projects/${id}`) : Promise.reject(new Error('unchanged')),
          changedJobs ? projectApi<{ jobs: ProjectJob[] }>(`/projects/${id}/jobs?limit=40`) : Promise.reject(new Error('unchanged')),
          changedProject || changedJobs || directorStale.current ? projectApi<DirectorSnapshot>(`/projects/${id}/director`) : Promise.reject(new Error('skip-director')),
        ]);
        // 切工程的 load 在 React effect 清理之前即可完成；ref 也挡住这一小段竞态。
        if (stopped || activeProjectId.current !== id) return;
        if (currentResult.status === 'fulfilled') {
          const current = currentResult.value;
          setProject((previous) => previous?.id === id && previous.revision <= current.revision ? current : previous);
          projectVersion = version.revision;
        }
        if (jobResult.status === 'fulfilled') { setJobs(jobResult.value.jobs); jobsVersion = version.jobsVersion; }
        if (directorResult.status === 'fulfilled') {
          const snapshot = directorResult.value;
          directorStale.current = false;
          if (snapshot.projectId !== id) {
            setDirectorState({ projectId: id, status: 'error', error: '服务端返回了其他工程的导演状态' });
          } else if (!snapshot.director) {
            setDirectorState({ projectId: id, status: 'absent' });
          } else {
            setDirectorState({ projectId: id, status: 'ready', snapshot });
          }
        } else if (directorResult.reason instanceof Error && directorResult.reason.message === 'skip-director') {
          // 本轮不取导演状态，保留上一次结果
        } else if (directorResult.reason instanceof ProjectApiError && directorResult.reason.status === 404) {
          setDirectorState({ projectId: id, status: 'absent' });
        } else {
          setDirectorState({ projectId: id, status: 'error', error: message(directorResult.reason) });
        }
        // 轮询错误与操作错误分开：服务恢复后自动清除，也不覆盖用户操作的报错。
        const firstError = [currentResult, jobResult].find((result) => result.status === 'rejected' && !(result.reason instanceof Error && result.reason.message === 'unchanged'));
        setPollError(firstError?.status === 'rejected' ? message(firstError.reason) : '');
      } catch (err) {
        if (!stopped && err instanceof ProjectApiError && err.status === 404) {
          setServiceWarning('当前后端不支持轻量轮询：已暂停任务列表和导演自动读取，请在后台任务完成后更新服务。');
          setPollError('');
        } else if (!stopped) setPollError(message(err));
      }
      finally { polling = false; }
    };
    void tick(); const timer = window.setInterval(() => void tick(), 2500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [project?.id]);

  // 工程版本一变（如接受审片），下一轮轮询立即取导演快照，而不是等到第 3 轮。
  useEffect(() => { directorStale.current = true; }, [project?.revision]);
  return { projects, project, setProject, jobs, setJobs, directorState, setDirectorState, pollError, serviceWarning, activeProjectId, refreshList, load };
}
