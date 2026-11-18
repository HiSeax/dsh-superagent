/** Main Session tools that manage the deployment's team at runtime: add, edit, remove, list and message a teammate. */
import { z } from 'zod'
import type { Team } from '../team.ts'
import { tool, type Tool } from './tool.ts'

/** What the team tools need: the roster's runtime operations, none of which needs a restart or a settings edit. */
export interface TeamToolsHost {
  readonly team: Pick<Team, 'list' | 'add' | 'update' | 'remove' | 'message'>
}

const TEAMMATE = z.string().trim().min(1).max(80).describe('The teammate\'s id or current name.')
const NAME = z.string().trim().min(1).max(40).describe('The display name, which is also its Session title; any script is allowed.')
const ROLE = z.string().trim().min(1).max(200).describe('What the teammate is responsible for, in one sentence.')
const BRIEF = z.string().trim().max(4000).describe('Extra standing instructions its system prompt includes; an empty string clears them.')

/** Builds the main Session's team tools. Each runs on the live team, so a change applies without a restart. */
export function teamTools(host: TeamToolsHost): Tool[] {
  return [
    tool({
      name: 'orchestrator_team_list',
      description: 'List the team\'s teammates with their ids, names, responsibilities and live state; one whose Session is not loaded reports stored.',
      schema: z.object({}).strict(),
      execute: async () => ({ teammates: await host.team.list() }),
    }),
    tool({
      name: 'orchestrator_team_add',
      description: 'Add a teammate on a person\'s explicit request: create the DSH Session that runs it, or adopt an existing Session by id. It works at once, with no restart or settings edit.',
      schema: z.object({
        name: NAME,
        role: ROLE,
        brief: BRIEF.optional(),
        session_id: z.string().trim().min(1).max(200).optional().describe('Adopt this existing DSH Session instead of creating one; it must not be the main Session or a ticket\'s worker.'),
      }).strict(),
      execute: async args => host.team.add({ name: args.name, role: args.role,
        ...(args.brief !== undefined ? { brief: args.brief } : {}), ...(args.session_id ? { sessionId: args.session_id } : {}) }),
    }),
    tool({
      name: 'orchestrator_team_update',
      description: 'Change a teammate\'s name, responsibility or brief on a person\'s explicit request; a new name becomes its Session title, and a new brief applies from its next model request.',
      schema: z.object({ teammate: TEAMMATE, name: NAME.optional(), role: ROLE.optional(), brief: BRIEF.optional() }).strict(),
      execute: async args => host.team.update(args.teammate, { ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.role !== undefined ? { role: args.role } : {}), ...(args.brief !== undefined ? { brief: args.brief } : {}) }),
    }),
    tool({
      name: 'orchestrator_team_remove',
      description: 'Remove a teammate on a person\'s explicit request: archive its Session, stopping the work it still runs, and drop it from the team. Nobody may be removed from a name alone; confirm the teammate first.',
      schema: z.object({ teammate: TEAMMATE }).strict(),
      execute: async args => host.team.remove(args.teammate),
    }),
    tool({
      name: 'orchestrator_team_message',
      description: 'Send a message into a teammate\'s Session: queued for its next turn, or steered into the current one; an inactive Session wakes to read it.',
      schema: z.object({
        teammate: TEAMMATE,
        text: z.string().trim().min(1).max(20000),
        mode: z.enum(['queue', 'steer']).default('queue').describe('queue delivers at its next turn; steer delivers at its nearest step boundary and wakes it.'),
      }).strict(),
      execute: async args => host.team.message(args.teammate, args.text, args.mode),
    }),
  ]
}
