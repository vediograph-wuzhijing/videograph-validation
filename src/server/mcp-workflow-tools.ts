import { serviceFetch } from './mcp-feedback-tools.ts';
const base = { projectId:{type:'string'} };
const draft = {...base,shotId:{type:'string'},expectedProjectRevision:{type:'integer',minimum:0},code:{type:'string',maxLength:200000},params:{type:'object'}};
const schema = (properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required,additionalProperties:false});
export const workflowToolDefinitions = [
  {name:'scene_component_search',description:'检索内置场景基础件：3D相机/投影/世界卡片、海/天空/水下、逐字动画、选择性图层后期。返回可用导出与用法；也请搜索 effect_search 特效箱及转场。',inputSchema:schema({query:{type:'string',maxLength:200}},[])},
  {name:'scene_component_get',description:'读取基础件类型化TS源码、导出和用法。新工程可直接import；旧工程可内联返回代码到场景源码，经draft/check验证，不改冻结引擎。',inputSchema:schema({id:{enum:['world','environment','text-motion','layers']}},['id'])},
  {name:'project_scene_module_submit',description:'一次提交工程级共享场景及所有引用镜头，只存一份源码、一个修订。bindings 含每镜 shotId/expectedInputRevision/params、意见响应及导演 attemptToken；任何锁定或版本冲突整批回滚。更新已有模块必须包含所有引用镜头。',inputSchema:schema({...base,moduleId:{type:'string'},expectedProjectRevision:{type:'integer',minimum:0},code:{type:'string',maxLength:200000},summary:{type:'string'},bindings:{type:'array',minItems:1,maxItems:500,items:{type:'object',properties:{shotId:{type:'string'},expectedInputRevision:{type:'integer',minimum:0},params:{type:'object'},attemptToken:{type:'string'},addressedFeedbackIds:{type:'array',items:{type:'string'}},feedbackResponses:{type:'array',items:{type:'object'}}},required:['shotId','expectedInputRevision'],additionalProperties:false}}},['projectId','moduleId','expectedProjectRevision','code','bindings'])},
  {name:'project_draft_check',description:'临时源码的 TypeScript 检查及初始化着色器编译，不抽帧、不建任务、不写修订。返回覆盖范围；render 中动态创建的着色器仍需正式验证。',inputSchema:schema(draft,['projectId','shotId','expectedProjectRevision'])},
  {name:'project_draft_preview',description:'打开未提交源码的真实引擎草稿播放器，返回临时本机URL，可看连续运动；不写源码文件、任务或修订，正式采用须另行提交源码。',inputSchema:schema(draft,['projectId','shotId','expectedProjectRevision'])},
  {name:'project_draft_stills',description:'即时渲染未提交源码的1..12个时间点，返回带镜头号/时间的临时PNG联系表；不写任务和修订，适合快速迭代或两秒运动检查。',inputSchema:schema({...draft,times:{type:'array',minItems:1,maxItems:12,items:{type:'number'}}},['projectId','shotId','expectedProjectRevision'])},
  {name:'project_version_get',description:'轻量轮询工程修订及任务版本；仅变化时再读 project_get 或任务分页。',inputSchema:schema(base,['projectId'])},
  {name:'service_health_get',description:'读取服务代码是否过期、数据库大小、任务队列和操作积压；健康检查不读取任务大行。',inputSchema:schema({},[])},
];
export const workflowToolNames = new Set(workflowToolDefinitions.map(t=>t.name));
export async function callWorkflowTool(name:string,args:Record<string,unknown>) {
  const id = encodeURIComponent(String(args.projectId??'')), {projectId,...input}=args;
  if(name==='service_health_get') return serviceFetch('/health');
  if(name==='scene_component_search') return serviceFetch(`/scene-components?query=${encodeURIComponent(String(args.query??''))}`);
  if(name==='scene_component_get') return serviceFetch(`/scene-components/${encodeURIComponent(String(args.id))}`);
  if(name==='project_version_get') return serviceFetch(`/projects/${id}/version`);
  if(name==='project_scene_module_submit') return serviceFetch(`/projects/${id}/scene-modules/${encodeURIComponent(String(args.moduleId))}`,{...input,author:'mcp'});
  const action = {project_draft_check:'check',project_draft_preview:'preview',project_draft_stills:'stills'}[name];
  if(!action) throw new Error('unknown workflow tool');
  const result = await serviceFetch(`/projects/${id}/draft/${action}`,input);
  if(name==='project_draft_stills') {
    const image = result.image as {mimeType:string;base64:string};
    return {content:[{type:'text' as const,text:JSON.stringify({...result,image:undefined})},{type:'image' as const,data:image.base64,mimeType:image.mimeType}]};
  }
  return result;
}
