// HTTP fallback for sessions without an MCP connection; uses the same tool
// adapters and service credential. No human-adoption authority is granted.
import { readFileSync } from 'node:fs';
import { callProjectTool, projectToolDefinitions } from '../src/server/mcp-tools.ts';
import { callFeedbackTool, feedbackToolDefinitions } from '../src/server/mcp-feedback-tools.ts';
import { callAeTool, aeToolDefinitions } from '../src/server/mcp-ae-tools.ts';
import { callDirectorTool, directorToolDefinitions } from '../src/server/mcp-director-tools.ts';
import { callVocalTool, vocalToolDefinitions } from '../src/server/mcp-vocal-tools.ts';
import { callWorkflowTool, workflowToolDefinitions } from '../src/server/mcp-workflow-tools.ts';
import {callFxTool,fxToolDefinitions} from '../src/server/mcp-fx-tools.ts';
const groups=[[projectToolDefinitions,callProjectTool],[feedbackToolDefinitions,callFeedbackTool],[aeToolDefinitions,callAeTool],[directorToolDefinitions,callDirectorTool],[vocalToolDefinitions,callVocalTool],[workflowToolDefinitions,callWorkflowTool],[fxToolDefinitions,callFxTool]];
const [command,name,file]=process.argv.slice(2);
try {
  if(command==='tools') console.log(JSON.stringify(groups.flatMap(([definitions])=>definitions),null,2));
  else if(command==='call'&&name) {
    const group=groups.find(([definitions])=>definitions.some(tool=>tool.name===name));
    if(!group) throw new Error('unknown HTTP project tool; run tools to inspect parameters');
    const args=file?JSON.parse(readFileSync(file,'utf8')):{};
    if(!args||typeof args!=='object'||Array.isArray(args)) throw new Error('arguments must be a JSON object');
    console.log(JSON.stringify(await group[1](name,args),null,2));
  } else throw new Error('Usage: node scripts/project-client.mjs tools | call <toolName> [args.json]. Start with service_health_get and project_list; use project_feedback_inbox/filmstrip/contact_sheet before editing.');
}catch(error){console.error(error.message);process.exitCode=1;}
