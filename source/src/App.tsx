import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import JSZip from 'jszip';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  Copy,
  Download,
  FileCode2,
  FilePlus2,
  Eye,
  Search,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Trash2,
  LogOut,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Users,
  X,
  Sparkles,
  Target,
  CheckCircle2,
  Upload,
} from 'lucide-react';
import { api, ws } from '@appdeploy/client';

type User = {
  userId: string;
  name?: string;
  username?: string;
  role: 'admin' | 'member';
};
type AdminAccount = {
  userId: string;
  username: string;
  name: string;
  role: string;
  createdAt: number;
};

type Project = {
  id: string;
  name: string;
  inviteCode: string;
  ownerId: string;
  createdAt: number;
};

type ProjectFile = {
  id: string;
  projectId: string;
  parentId?: string | null;
  name: string;
  content: string;
  updatedAt: number;
};

type ProjectFolder = {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type Member = {
  id: string;
  userId: string;
  name: string;
  email?: string;
  role: string;
};
type TeamProfile = {
  skills: string[];
  interests: string[];
  experience: string;
};
type TeamAssignment = {
  id: string;
  userId: string;
  memberName: string;
  role: string;
  title: string;
  tasks: string[];
  rationale: string;
  status: string;
};

const languageFor = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const languages: Record<string, string> = {
    html: 'html',
    css: 'css',
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sh: 'shell',
  };
  return languages[ext || ''] || 'plaintext';
};

function buildPreviewDocument(files: ProjectFile[]) {
  const root = files.find(
    file => !file.parentId && file.name.toLowerCase() === 'index.html'
  );
  const html =
    root?.content ||
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nova Preview</title></head><body><main><h1>Welcome to your preview</h1><p>Create an index.html file to get started.</p></main></body></html>';
  const css =
    files.find(
      file => !file.parentId && file.name.toLowerCase() === 'style.css'
    )?.content || '';
  const js =
    files.find(
      file => !file.parentId && file.name.toLowerCase() === 'script.js'
    )?.content || '';
  let document = html;
  if (css) {
    const styleTag = '<style>\\n' + css + '\\n</style>';
    const headIndex = document.toLowerCase().indexOf('</head>');
    if (headIndex >= 0) {
      document =
        document.slice(0, headIndex) + styleTag + document.slice(headIndex);
    } else {
      document = document.replace('<head>', '<head>' + styleTag);
    }
  }
  if (js) {
    const scriptTag = '<script>\\n' + js + '\\n</script>';
    const bodyIndex = document.toLowerCase().indexOf('</body>');
    if (bodyIndex >= 0) {
      document =
        document.slice(0, bodyIndex) + scriptTag + document.slice(bodyIndex);
    } else {
      document += scriptTag;
    }
  }
  return document;
}

const PALETTE_COMMANDS = [
  { id: 'save', label: 'Save active file', shortcut: 'Ctrl/Cmd+S' },
  { id: 'quick-open', label: 'Quick Open File', shortcut: 'Ctrl/Cmd+P' },
  { id: 'toggle-explorer', label: 'Toggle Explorer', shortcut: 'Ctrl/Cmd+B' },
  { id: 'toggle-preview', label: 'Toggle Live Preview', shortcut: 'F5' },
  { id: 'toggle-assistant', label: 'Toggle Nova Assistant', shortcut: '' },
  { id: 'new-file', label: 'Create New File', shortcut: '' },
  { id: 'new-folder', label: 'Create New Folder', shortcut: '' },
  { id: 'rename-file', label: 'Rename Active File', shortcut: 'F2' },
  { id: 'close-tab', label: 'Close Active Tab', shortcut: 'Ctrl/Cmd+W' },
  { id: 'close-all', label: 'Close All Tabs', shortcut: 'Ctrl/Cmd+Shift+W' },
];

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [newAccountUsername, setNewAccountUsername] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [adminAccounts, setAdminAccounts] = useState<AdminAccount[]>([]);
  const [accountNotice, setAccountNotice] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set()
  );
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [dirtyFileIds, setDirtyFileIds] = useState<Set<string>>(new Set());
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(
    null
  );
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [explorerQuery, setExplorerQuery] = useState('');
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteActiveIndex, setPaletteActiveIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [members, setMembers] = useState<Member[]>([]);
  const [teamProfile, setTeamProfile] = useState<TeamProfile>({
    skills: [],
    interests: [],
    experience: 'intermediate',
  });
  const [teamSkillsText, setTeamSkillsText] = useState('');
  const [teamInterestsText, setTeamInterestsText] = useState('');
  const [teamAssignments, setTeamAssignments] = useState<TeamAssignment[]>([]);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamNotice, setTeamNotice] = useState('');
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupMode, setSetupMode] = useState<'ai' | 'prompt'>('ai');
  const [setupPrompt, setSetupPrompt] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);
  const [selectedFile, setSelectedFile] = useState<ProjectFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(
    null
  );

  const askForConfirmation = (title: string, message: string) =>
    new Promise<boolean>(resolve => {
      confirmResolverRef.current = resolve;
      setConfirmDialog({ title, message });
    });

  const closeConfirmation = (confirmed: boolean) => {
    setConfirmDialog(null);
    confirmResolverRef.current?.(confirmed);
    confirmResolverRef.current = null;
  };
  const [projectName, setProjectName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showDeployment, setShowDeployment] = useState(false);
  const [deploymentCheckBusy, setDeploymentCheckBusy] = useState(false);
  const [deploymentActivity, setDeploymentActivity] = useState<
    Array<{ id: string; status: string; summary: string; createdAt: number }>
  >([]);
  const [deploymentIntegrations, setDeploymentIntegrations] = useState<
    Record<string, { configured: boolean; connected: boolean; message: string }>
  >({});
  const [integrationVerifyBusy, setIntegrationVerifyBusy] = useState(false);
  const [githubRepositoryUrl, setGithubRepositoryUrl] = useState('');
  const [githubBranch, setGithubBranch] = useState('');
  const [githubReadme, setGithubReadme] = useState('');
  const [githubGitignore, setGithubGitignore] = useState('');
  const [githubLicenseChoice, setGithubLicenseChoice] = useState<
    'MIT' | 'None'
  >('MIT');
  const [githubLicenseText, setGithubLicenseText] = useState('');
  const [githubPushBusy, setGithubPushBusy] = useState(false);
  const [githubPushResult, setGithubPushResult] = useState<{
    repositoryUrl: string;
    branch: string;
    commitSha: string;
    fileCount: number;
    skippedFiles: number;
  } | null>(null);
  const [vercelDeployments, setVercelDeployments] = useState<
    Array<{
      id?: string;
      deploymentId: string;
      projectName: string;
      url: string;
      status: string;
      framework: string;
      errorMessage?: string;
      createdAt: number;
      updatedAt: number;
    }>
  >([]);
  const [vercelDeployBusy, setVercelDeployBusy] = useState(false);
  const [netlifyDeployments, setNetlifyDeployments] = useState<
    Array<{
      id?: string;
      deploymentId: string;
      projectName: string;
      url: string;
      status: string;
      framework: string;
      errorMessage?: string;
      createdAt: number;
      updatedAt: number;
    }>
  >([]);
  const [netlifyDeployBusy, setNetlifyDeployBusy] = useState(false);
  const [netlifyRefreshBusy, setNetlifyRefreshBusy] = useState<string | null>(
    null
  );
  const [netlifyDeployError, setNetlifyDeployError] = useState('');
  const [renderWorkspaces, setRenderWorkspaces] = useState<
    Array<{ id: string; name: string; email: string; type: string }>
  >([]);
  const [selectedRenderOwnerId, setSelectedRenderOwnerId] = useState('');
  const [renderRepo, setRenderRepo] = useState('');
  const [renderBranch, setRenderBranch] = useState('main');
  const [renderBuildCommand, setRenderBuildCommand] = useState(
    'npm ci && npm run build'
  );
  const [renderPublishPath, setRenderPublishPath] = useState('dist');
  const [renderService, setRenderService] = useState<{
    serviceId: string;
    serviceName: string;
    ownerName: string;
    repo: string;
    branch: string;
    buildCommand: string;
    publishPath: string;
    url: string;
    dashboardUrl: string;
    createdAt: number;
  } | null>(null);
  const [renderDeployments, setRenderDeployments] = useState<
    Array<{
      deploymentId: string;
      status: string;
      trigger: string;
      commitMessage: string;
      commitId: string;
      createdAt: number;
      updatedAt: number;
    }>
  >([]);
  const [renderWorkspaceBusy, setRenderWorkspaceBusy] = useState(false);
  const [renderCreateBusy, setRenderCreateBusy] = useState(false);
  const [renderDeployBusy, setRenderDeployBusy] = useState(false);
  const [renderRefreshBusy, setRenderRefreshBusy] = useState(false);
  const [renderResetBusy, setRenderResetBusy] = useState(false);
  const [renderAvailableServices, setRenderAvailableServices] = useState<
    Array<{
      serviceId: string;
      serviceName: string;
      ownerId: string;
      ownerName: string;
      repo: string;
      branch: string;
      buildCommand: string;
      publishPath: string;
      url: string;
      dashboardUrl: string;
      createdAt: number;
    }>
  >([]);
  const [renderSelectedExistingServiceId, setRenderSelectedExistingServiceId] =
    useState('');
  const [renderAvailableBusy, setRenderAvailableBusy] = useState(false);
  const [renderConnectBusy, setRenderConnectBusy] = useState(false);
  const [renderError, setRenderError] = useState('');

  const [vercelRefreshBusy, setVercelRefreshBusy] = useState<string | null>(
    null
  );
  const [vercelDeployError, setVercelDeployError] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const zipImportRef = useRef<HTMLInputElement>(null);
  const folderImportRef = useRef<HTMLInputElement>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantPrompt, setAssistantPrompt] = useState('');
  const [assistantAnswer, setAssistantAnswer] = useState('');
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantMode, setAssistantMode] = useState<'chat' | 'edit'>('chat');
  const [assistantProvider, setAssistantProvider] = useState<
    'auto' | 'gemini' | 'groq'
  >('auto');
  const [assistantUsage, setAssistantUsage] = useState<number | null>(null);
  const [assistantProviders, setAssistantProviders] = useState({
    gemini: false,
    groq: false,
  });
  const [pendingPlan, setPendingPlan] = useState<{
    summary: string;
    changes: Array<{
      fileId: string;
      fileName: string;
      baseContent: string;
      content: string;
      reason: string;
    }>;
  } | null>(null);
  const [applyingPlan, setApplyingPlan] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectionState, setConnectionState] = useState<
    'connecting' | 'connected' | 'offline'
  >('connecting');
  const connRef = useRef<ReturnType<typeof ws.connect> | null>(null);
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingSavesRef = useRef<Record<string, { projectId: string; content: string }>>({});
  const savePromisesRef = useRef<Record<string, Promise<boolean>>>({});
  const fileDraftsRef = useRef<Record<string, string>>({});
  const activeProjectRef = useRef<Project | null>(null);
  const projectLoadRequestRef = useRef(0);
  const restoreAttemptedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    api
      .get('/api/auth/me')
      .then(response => {
        if (alive) setUser(response.data.user || null);
      })
      .catch(() => {
        if (alive) setUser(null);
      })
      .finally(() => {
        if (alive) setAuthLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const loadProjects = useCallback(async () => {
    const response = await api.get('/api/projects');
    setProjects(response.data.projects || []);
  }, []);

  useEffect(() => {
    if (!user) return;
    loadProjects().catch(err =>
      setErrorMessage(err?.message || 'Could not load projects.')
    );
  }, [user, loadProjects]);

  useEffect(() => {
    if (user?.role !== 'admin') {
      setAdminAccounts([]);
      return;
    }
    api
      .get('/api/admin/users')
      .then(response => setAdminAccounts(response.data.users || []))
      .catch(() => setAccountNotice('Could not load account list.'));
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const connection = ws.connect();
    connRef.current = connection;
    setConnectionState('connecting');

    connection.onOpen(() => setConnectionState('connected'));
    connection.onClose(() => setConnectionState('offline'));
    connection.onError(() => setConnectionState('offline'));
    connection.onMessage(message => {
      const payload = message?.payload;
      if (
        message?.type !== 'entity.update' ||
        payload?.entity_type !== 'project'
      )
        return;
      const currentProject = activeProjectRef.current;
      if (!currentProject || payload.entity_id !== currentProject.id) return;
      const data = payload.data;
      if (data?.action === 'folder-created' && data.folder) {
        setFolders(current =>
          current.some(item => item.id === data.folder.id)
            ? current
            : [...current, data.folder]
        );
      }
      if (data?.action === 'folder-updated' && data.folder) {
        setFolders(current =>
          current.map(item => (item.id === data.folder.id ? data.folder : item))
        );
      }
      if (data?.action === 'folder-deleted' && data.folderIds) {
        const removed = new Set(data.folderIds);
        const removedFiles = new Set(data.fileIds || []);
        setFolders(current => current.filter(item => !removed.has(item.id)));
        setFiles(current => current.filter(item => !removedFiles.has(item.id)));
        setOpenTabIds(current => current.filter(id => !removedFiles.has(id)));
        setSelectedFile(current =>
          current && removedFiles.has(current.id) ? null : current
        );
      }
      if (data?.action === 'file-created' && data.file) {
        setFiles(current =>
          current.some(item => item.id === data.file.id)
            ? current
            : [...current, data.file]
        );
      }
      if (data?.action === 'file-updated' && data.file) {
        setFiles(current =>
          current.map(item => (item.id === data.file.id ? data.file : item))
        );
        setSelectedFile(current =>
          current?.id === data.file.id ? data.file : current
        );
      }
      if (data?.action === 'file-deleted' && data.fileId) {
        setFiles(current => current.filter(item => item.id !== data.fileId));
        setSelectedFile(current =>
          current?.id === data.fileId ? null : current
        );
      }
      if (data?.action === 'member-joined' && data.member) {
        setMembers(current =>
          current.some(item => item.userId === data.member.userId)
            ? current
            : [...current, data.member]
        );
        api
          .get('/api/projects/' + currentProject.id)
          .then(response => setMembers(response.data.members || []))
          .catch(() => undefined);
      }
      if (
        data?.action === 'team-plan-updated' &&
        Array.isArray(data.assignments)
      ) {
        setTeamAssignments(data.assignments);
        setTeamNotice('The project owner published an updated team plan.');
      }
      if (data?.action === 'team-assignment-responded' && data.assignment) {
        const updated = data.assignment as TeamAssignment;
        setTeamAssignments(current =>
          current.map(item => (item.id === updated.id ? updated : item))
        );
        setTeamNotice(
          updated.memberName +
            (updated.status === 'accepted'
              ? ' accepted their role.'
              : ' requested a change to their role.')
        );
      }
      if (data?.action === 'team-acceptance-progress' && data.allAccepted) {
        setTeamNotice('');
      }
      if (
        data?.action === 'team-profile-updated' &&
        data.userId !== user?.userId
      ) {
        setTeamNotice('A teammate updated their skills profile.');
      }
      if (data?.action === 'project-scaffold-created') {
        const projectId = activeProjectRef.current?.id;
        if (projectId && projectId === message?.payload?.entity_id) {
          Promise.all([
            api.get('/api/projects/' + projectId),
            api.get('/api/projects/' + projectId + '/folders'),
          ])
            .then(([projectResponse, folderResponse]) => {
              const refreshedFiles = projectResponse.data.files || [];
              setFiles(refreshedFiles);
              fileDraftsRef.current = Object.fromEntries(
                refreshedFiles.map((file: ProjectFile) => [
                  file.id,
                  file.content,
                ])
              );
              setFolders(folderResponse.data.folders || []);
              setExpandedFolders(
                new Set(
                  (folderResponse.data.folders || []).map(
                    (folder: ProjectFolder) => folder.id
                  )
                )
              );
              setTeamNotice(
                'NOVA finished creating the shared project structure.'
              );
            })
            .catch(() =>
              setTeamNotice(
                'NOVA created the structure. Reconnect to load the latest files.'
              )
            );
        }
      }
    });

    connection.ready
      .then(() => setConnectionState('connected'))
      .catch(() => setConnectionState('offline'));
    return () => {
      connection.disconnect();
      connRef.current = null;
    };
  }, [user]);

  useEffect(() => {
    activeProjectRef.current = activeProject;
  }, [activeProject]);

  useEffect(() => {
    if (!activeProject) return;
    setGithubRepositoryUrl('');
    setGithubBranch('');
    setGithubReadme(
      '# ' +
        activeProject.name +
        '\n\n## Overview\n\nDescribe what this project does and who it is for.\n\n## Getting started\n\nAdd setup and run instructions for your project.\n\n## Features\n\n- Add the main project features here.\n'
    );
    setGithubGitignore(
      'node_modules/\ndist/\nbuild/\ncoverage/\n.env\n.env.*\n!.env.example\n*.log\n.DS_Store\n'
    );
    setGithubLicenseChoice('MIT');
    setGithubLicenseText(
      'MIT License\n\nCopyright (c) ' +
        new Date().getFullYear() +
        ' ' +
        (user?.name || 'Project contributors') +
        '\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n'
    );
    setGithubPushResult(null);
    setVercelDeployments([]);
    setVercelDeployError('');
    setNetlifyDeployments([]);
    setNetlifyDeployError('');
    setRenderService(null);
    setRenderDeployments([]);
    setRenderWorkspaces([]);
    setSelectedRenderOwnerId('');
    setRenderError('');
  }, [activeProject?.id]);

  useEffect(() => {
    const project = activeProject;
    const connection = connRef.current;
    if (!project || !connection) return;
    let cancelled = false;
    connection.ready
      .then(async () => {
        if (!cancelled && connection.connectionId) {
          await api.post('/api/projects/' + project.id + '/subscribe', {
            connection_id: connection.connectionId,
          });
          const snapshot = await api.get('/api/projects/' + project.id);
          if (!cancelled) setMembers(snapshot.data.members || []);
        }
      })
      .catch(() => setConnectionState('offline'));

    return () => {
      cancelled = true;
      if (connection.connectionId) {
        api
          .post('/api/projects/' + project.id + '/unsubscribe', {
            connection_id: connection.connectionId,
          })
          .catch(() => undefined);
      }
    };
  }, [activeProject?.id]);

  useEffect(
    () => () => {
      Object.values(saveTimersRef.current).forEach(timer => clearTimeout(timer));
    },
    []
  );

  useEffect(() => {
    if (!dirtyFileIds.size) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [dirtyFileIds.size]);

  const openProject = async (project: Project) => {
    const requestId = ++projectLoadRequestRef.current;
    setLoading(true);
    setErrorMessage('');
    try {
      const [response, folderResponse] = await Promise.all([
        api.get('/api/projects/' + project.id),
        api.get('/api/projects/' + project.id + '/folders'),
      ]);
      if (requestId !== projectLoadRequestRef.current) return;
      const loadedFiles = response.data.files || [];
      activeProjectRef.current = response.data.project;
      setActiveProject(response.data.project);
      localStorage.setItem('nova:last-project:' + user!.userId, project.id);
      setFiles(loadedFiles);
      fileDraftsRef.current = Object.fromEntries(
        loadedFiles.map((file: ProjectFile) => [file.id, file.content])
      );
      setFolders(folderResponse.data.folders || []);
      setExpandedFolders(new Set());
      setCurrentFolderId(null);
      setMembers(response.data.members || []);
      try {
        const teamResponse = await api.get(
          '/api/projects/' + project.id + '/team'
        );
        const profile = teamResponse.data.profile || {
          skills: [],
          interests: [],
          experience: 'intermediate',
        };
        setTeamProfile(profile);
        setTeamSkillsText((profile.skills || []).join(', '));
        setTeamInterestsText((profile.interests || []).join(', '));
        setTeamAssignments(teamResponse.data.assignments || []);
      } catch {
        if (requestId === projectLoadRequestRef.current) setTeamNotice('Team planner is temporarily unavailable.');
      }
      if (requestId !== projectLoadRequestRef.current) return;
      const rememberedFileId = user
        ? localStorage.getItem(
            'nova:last-file:' + user.userId + ':' + project.id
          )
        : null;
      const initialFile =
        loadedFiles.find((file: ProjectFile) => file.id === rememberedFileId) ||
        loadedFiles[0] ||
        null;
      setSelectedFile(initialFile);
      setOpenTabIds(initialFile ? [initialFile.id] : []);
      setDirtyFileIds(new Set());
      setNotice('');
    } catch (err: any) {
      if (requestId === projectLoadRequestRef.current) setErrorMessage(err?.response?.data?.error || err?.message || 'Could not open this project.');
    } finally {
      if (requestId === projectLoadRequestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (
      !user ||
      !projects.length ||
      activeProject ||
      restoreAttemptedRef.current
    )
      return;
    restoreAttemptedRef.current = true;
    const savedProjectId = localStorage.getItem(
      'nova:last-project:' + user.userId
    );
    if (!savedProjectId) return;
    const savedProject = projects.find(
      project => project.id === savedProjectId
    );
    if (savedProject) {
      void openProject(savedProject);
    } else {
      localStorage.removeItem('nova:last-project:' + user.userId);
    }
  }, [user, projects, activeProject]);

  const flushFileSave = async (fileId: string): Promise<boolean> => {
    const timer = saveTimersRef.current[fileId];
    if (timer) { clearTimeout(timer); delete saveTimersRef.current[fileId]; }
    const running = savePromisesRef.current[fileId];
    if (running) {
      const completed = await running;
      if (!completed) return false;
      return pendingSavesRef.current[fileId] ? flushFileSave(fileId) : true;
    }
    if (!pendingSavesRef.current[fileId]) return true;
    const worker = (async () => {
      while (pendingSavesRef.current[fileId]) {
        const task = pendingSavesRef.current[fileId];
        delete pendingSavesRef.current[fileId];
        try {
          const response = await api.put('/api/projects/' + task.projectId + '/files/' + fileId, {
            content: task.content,
            connection_id: connRef.current?.connectionId || undefined,
          });
          const savedFile = response.data.file as ProjectFile;
          const latestDraft = fileDraftsRef.current[fileId];
          const isCurrentProject = activeProjectRef.current?.id === task.projectId;
          if (isCurrentProject) {
            setFiles(current => current.map(item => item.id === fileId ? { ...savedFile, content: latestDraft ?? task.content } : item));
            setSelectedFile(current => current?.id === fileId ? { ...savedFile, content: latestDraft ?? task.content } : current);
          }
          if (latestDraft === task.content && !pendingSavesRef.current[fileId]) {
            setDirtyFileIds(current => { const next = new Set(current); next.delete(fileId); return next; });
            if (isCurrentProject) setNotice('Saved');
          } else if (isCurrentProject) setNotice('Saving latest changes…');
        } catch (err: any) {
          if (!pendingSavesRef.current[fileId]) pendingSavesRef.current[fileId] = task;
          setErrorMessage(err?.response?.data?.error || err?.message || 'Save failed. Your latest edit is still in this workspace; retry with Ctrl/Cmd+S.');
          setNotice('Save failed · press Ctrl/Cmd+S to retry');
          return false;
        }
      }
      return true;
    })();
    savePromisesRef.current[fileId] = worker;
    const completed = await worker;
    if (savePromisesRef.current[fileId] === worker) delete savePromisesRef.current[fileId];
    if (completed && pendingSavesRef.current[fileId]) return flushFileSave(fileId);
    return completed;
  };

  const leaveWorkspace = async (): Promise<boolean> => {
    const saveIds = Array.from(new Set([
      ...Object.keys(pendingSavesRef.current),
      ...Object.keys(savePromisesRef.current),
      ...Object.keys(saveTimersRef.current),
    ]));
    const saveResults = await Promise.all(saveIds.map(id => flushFileSave(id)));
    if (saveResults.some(result => !result) || saveIds.some(id => pendingSavesRef.current[id])) {
      setErrorMessage('A file could not be saved. Your workspace is still open; retry with Ctrl/Cmd+S before leaving.');
      return false;
    }
    if (user) localStorage.removeItem('nova:last-project:' + user.userId);
    Object.values(saveTimersRef.current).forEach(timer => clearTimeout(timer));
    saveTimersRef.current = {};
    pendingSavesRef.current = {};
    projectLoadRequestRef.current += 1;
    activeProjectRef.current = null;
    setActiveProject(null);
    setFiles([]);
    fileDraftsRef.current = {};
    setFolders([]);
    setExpandedFolders(new Set());
    setOpenTabIds([]);
    setDirtyFileIds(new Set());
    setCurrentFolderId(null);
    setMembers([]);
    setTeamProfile({ skills: [], interests: [], experience: 'intermediate' });
    setTeamSkillsText('');
    setTeamInterestsText('');
    setTeamAssignments([]);
    setTeamNotice('');
    setSelectedFile(null);
    setShowMembers(false);
    setNotice('');
    return true;
  };

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!projectName.trim()) return;
    setBusy(true);
    setErrorMessage('');
    try {
      const response = await api.post('/api/projects', {
        name: projectName.trim(),
      });
      setProjectName('');
      await loadProjects();
      await openProject(response.data.project);
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error ||
          err?.message ||
          'Could not create project.'
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteProject = async (project: Project) => {
    if (!user || project.ownerId !== user.userId) return;
    const confirmed = await askForConfirmation(
      'Delete project?',
      'Permanently delete "' +
        project.name +
        '" and all its NOVA IDE files, folders, team records and deployment history? This cannot be undone.'
    );
    if (!confirmed) return;

    setBusy(true);
    setErrorMessage('');
    setNotice('');
    try {
      await api.delete('/api/projects/' + project.id);
      setProjects(current => current.filter(item => item.id !== project.id));
      setNotice('Project "' + project.name + '" was deleted.');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error ||
          err?.message ||
          'Could not delete this project.'
      );
    } finally {
      setBusy(false);
    }
  };

  const joinProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!joinCode.trim()) return;
    setBusy(true);
    setErrorMessage('');
    try {
      const response = await api.post('/api/projects/join', {
        inviteCode: joinCode.trim().toUpperCase(),
      });
      setJoinCode('');
      await loadProjects();
      await openProject(response.data.project);
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error || err?.message || 'Could not join project.'
      );
    } finally {
      setBusy(false);
    }
  };

  const createFile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeProject || !newFileName.trim()) return;
    setBusy(true);
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/files',
        {
          name: newFileName.trim(),
          parentId: currentFolderId,
        }
      );
      setFiles(current =>
        current.some(item => item.id === response.data.file.id)
          ? current
          : [...current, response.data.file]
      );
      setSelectedFile(response.data.file);
      setOpenTabIds(current =>
        current.includes(response.data.file.id)
          ? current
          : [...current, response.data.file.id]
      );
      setCurrentFolderId(response.data.file.parentId || null);
      setNewFileName('');
      setShowNewFile(false);
      setNotice('File created');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error || err?.message || 'Could not create file.'
      );
    } finally {
      setBusy(false);
    }
  };

  const createFolder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeProject || !newFolderName.trim()) return;
    setBusy(true);
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/folders',
        {
          name: newFolderName.trim(),
          parentId: newFolderParentId,
        }
      );
      const folder = response.data.folder as ProjectFolder;
      setFolders(current => [...current, folder]);
      setExpandedFolders(current => new Set(current).add(folder.id));
      setNewFolderName('');
      setShowNewFolder(false);
      setNotice('Folder created');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error || err?.message || 'Could not create folder.'
      );
    } finally {
      setBusy(false);
    }
  };

  const renameFolder = async (folder: ProjectFolder) => {
    if (!activeProject) return;
    const name = window.prompt('Rename folder', folder.name);
    if (!name || !name.trim() || name.trim() === folder.name) return;
    try {
      const response = await api.put(
        '/api/projects/' + activeProject.id + '/folders/' + folder.id,
        { name: name.trim() }
      );
      setFolders(current =>
        current.map(item =>
          item.id === folder.id ? response.data.folder : item
        )
      );
      setNotice('Folder renamed');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error || err?.message || 'Could not rename folder.'
      );
    }
  };

  const deleteFolder = async (folder: ProjectFolder) => {
    if (!activeProject) return;
    const confirmed = await askForConfirmation(
      'Delete folder?',
      'Delete folder "' +
        folder.name +
        '" and everything inside it? This action cannot be undone.'
    );
    if (!confirmed) return;
    const descendantIds = new Set([folder.id]);
    let descendantsChanged = true;
    while (descendantsChanged) {
      descendantsChanged = false;
      folders.forEach(item => {
        if (item.parentId && descendantIds.has(item.parentId) && !descendantIds.has(item.id)) {
          descendantIds.add(item.id); descendantsChanged = true;
        }
      });
    }
    const nestedFileIds = files.filter(item => item.parentId && descendantIds.has(item.parentId)).map(item => item.id);
    const nestedSaveResults = await Promise.all(nestedFileIds.map(id => flushFileSave(id)));
    if (nestedSaveResults.some(result => !result)) return;
    try {
      const response = await api.delete(
        '/api/projects/' + activeProject.id + '/folders/' + folder.id
      );
      const folderIds = new Set<string>(response.data.folderIds || [folder.id]);
      const fileIds = new Set<string>(response.data.fileIds || []);
      setFolders(current => current.filter(item => !folderIds.has(item.id)));
      setFiles(current => current.filter(item => !fileIds.has(item.id)));
      setOpenTabIds(current => current.filter(id => !fileIds.has(id)));
      setSelectedFile(current =>
        current && fileIds.has(current.id) ? null : current
      );
      setNotice('Folder deleted');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error || err?.message || 'Could not delete folder.'
      );
    }
  };

  const renameFile = async (file: ProjectFile) => {
    if (!activeProject) return;
    const name = window.prompt('Rename file', file.name);
    if (!name || !name.trim() || name.trim() === file.name) return;
    if (!(await flushFileSave(file.id))) return;
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/files/' + file.id + '/rename',
        { name: name.trim() }
      );
      const renamed = response.data.file as ProjectFile;
      setFiles(current =>
        current.map(item => (item.id === file.id ? renamed : item))
      );
      setSelectedFile(current => (current?.id === file.id ? renamed : current));
      setNotice('File renamed');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error || err?.message || 'Could not rename file.'
      );
    }
  };

  const openFile = (file: ProjectFile) => {
    setSelectedFile(file);
    if (user && activeProject)
      localStorage.setItem(
        'nova:last-file:' + user.userId + ':' + activeProject.id,
        file.id
      );
    setOpenTabIds(current =>
      current.includes(file.id) ? current : [...current, file.id]
    );
  };

  const closeTab = (fileId: string) => {
    const remaining=openTabIds.filter(id=>id!==fileId); setOpenTabIds(remaining);
    if(selectedFile?.id===fileId)setSelectedFile(filesById.get(remaining[remaining.length-1])||null);
  };
  const runPaletteCommand = (id:string) => {
    setCommandPaletteOpen(false);setQuickOpenOpen(false);setPaletteQuery('');
    switch(id){
      case 'save': if(selectedFile)void flushFileSave(selectedFile.id); else void Promise.all(Object.keys(pendingSavesRef.current).map(key=>flushFileSave(key)));break;
      case 'quick-open':setQuickOpenOpen(true);break;
      case 'toggle-explorer':setExplorerCollapsed(v=>!v);break;
      case 'toggle-preview':setPreviewOpen(v=>!v);break;
      case 'toggle-assistant':setAssistantOpen(v=>!v);break;
      case 'new-file':setShowNewFile(true);break;
      case 'new-folder':setNewFolderParentId(currentFolderId);setShowNewFolder(true);break;
      case 'rename-file':if(selectedFile)void renameFile(selectedFile);break;
      case 'close-tab':if(selectedFile)closeTab(selectedFile.id);break;
      case 'close-all':setSelectedFile(null);setOpenTabIds([]);break;
    }
  };

  const saveTeamProfile = async () => {
    if (!activeProject || teamBusy) return;
    setTeamBusy(true);
    setTeamNotice('');
    try {
      const response = await api.put(
        '/api/projects/' + activeProject.id + '/team/profile',
        {
          skills: teamSkillsText,
          interests: teamInterestsText,
          experience: teamProfile.experience,
        }
      );
      setTeamProfile(response.data.profile);
      setTeamNotice(
        'Skill profile saved. Nova can now match your strengths to project work.'
      );
    } catch (err: any) {
      setTeamNotice(
        err?.response?.data?.error || 'Could not save your skill profile.'
      );
    } finally {
      setTeamBusy(false);
    }
  };

  const generateTeamPlan = async () => {
    if (!activeProject || teamBusy) return;
    setTeamBusy(true);
    setTeamNotice('Nova is matching skills to project requirements…');
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/team/plan',
        {}
      );
      setTeamAssignments(response.data.assignments || []);
      setTeamNotice(
        'Role proposals are ready. Each teammate can accept or request a change.'
      );
    } catch (err: any) {
      setTeamNotice(
        err?.response?.data?.error || 'Could not generate the team plan.'
      );
    } finally {
      setTeamBusy(false);
    }
  };

  const respondToAssignment = async (
    assignment: TeamAssignment,
    action: 'accept' | 'request-change'
  ) => {
    if (!activeProject || teamBusy) return;
    setTeamBusy(true);
    try {
      const response = await api.post(
        '/api/projects/' +
          activeProject.id +
          '/team/assignments/' +
          assignment.id +
          '/respond',
        { action }
      );
      setTeamAssignments(current =>
        current.map(item =>
          item.id === assignment.id ? response.data.assignment : item
        )
      );
      if (action === 'request-change') {
        setTeamNotice(
          'Change requested. The project owner can review the team plan.'
        );
      } else if (response.data.allAccepted) {
        setTeamNotice('');
      } else {
        setTeamNotice('Role accepted. Waiting for the remaining teammates.');
      }
    } catch (err: any) {
      setTeamNotice(
        err?.response?.data?.error || 'Could not update this assignment.'
      );
    } finally {
      setTeamBusy(false);
    }
  };

  const submitSetupChoice = async () => {
    if (
      !activeProject ||
      !user ||
      activeProject.ownerId !== user.userId ||
      setupBusy
    )
      return;
    const prompt = setupPrompt.trim();
    if (!prompt || prompt.length > 6000) {
      setTeamNotice(
        'Add project requirements or a structure prompt (maximum 6,000 characters).'
      );
      return;
    }
    setSetupBusy(true);
    setTeamNotice('NOVA is preparing the shared project structure…');
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/team/setup',
        { mode: setupMode, prompt }
      );
      setShowSetupModal(false);
      const [projectResponse, folderResponse] = await Promise.all([
        api.get('/api/projects/' + activeProject.id),
        api.get('/api/projects/' + activeProject.id + '/folders'),
      ]);
      const refreshedFiles = projectResponse.data.files || [];
      setFiles(refreshedFiles);
      fileDraftsRef.current = Object.fromEntries(
        refreshedFiles.map((file: ProjectFile) => [file.id, file.content])
      );
      setFolders(folderResponse.data.folders || []);
      setExpandedFolders(
        new Set(
          (folderResponse.data.folders || []).map(
            (folder: ProjectFolder) => folder.id
          )
        )
      );
      setTeamNotice(
        response.data.scaffold?.status === 'complete'
          ? 'NOVA created the shared project structure.'
          : response.data.setup?.status === 'failed'
            ? response.data.scaffold?.message ||
              'NOVA could not create the structure. Please review the prompt and retry in a new project setup.'
            : 'Setup choice saved.'
      );
    } catch (err: any) {
      setTeamNotice(
        err?.response?.data?.error ||
          err?.message ||
          'Could not start project setup.'
      );
    } finally {
      setSetupBusy(false);
    }
  };

  const startManualImport = (source: 'zip' | 'folder') => {
    if (!activeProject || !user || activeProject.ownerId !== user.userId)
      return;
    setShowSetupModal(false);
    if (source === 'zip') zipImportRef.current?.click();
    else folderImportRef.current?.click();
    api
      .post('/api/projects/' + activeProject.id + '/team/setup', {
        mode: 'manual',
      })
      .then(() =>
        setTeamNotice(
          'Import selected. Choose the project archive or folder to add it to this workspace.'
        )
      )
      .catch((err: any) =>
        setTeamNotice(
          err?.response?.data?.error || 'Could not save the import choice.'
        )
      );
  };

  const explorerFoldersByParent = useMemo(() => {
    const grouped = new Map<string, ProjectFolder[]>();
    folders.forEach(folder => { const key=folder.parentId||''; const group=grouped.get(key)||[]; group.push(folder); grouped.set(key,group); });
    grouped.forEach(group=>group.sort((a,b)=>a.name.localeCompare(b.name)));
    return grouped;
  }, [folders]);

  const explorerFilesByParent = useMemo(() => {
    const grouped = new Map<string, ProjectFile[]>();
    const query = explorerQuery.trim().toLowerCase();
    files.forEach(file => { if(query&&!file.name.toLowerCase().includes(query))return; const key=file.parentId||''; const group=grouped.get(key)||[]; group.push(file); grouped.set(key,group); });
    grouped.forEach(group=>group.sort((a,b)=>a.name.localeCompare(b.name)));
    return grouped;
  }, [files, explorerQuery]);

  const renderExplorer = (
    parentId: string | null,
    depth = 0
  ): React.ReactNode => {
    const parentKey = parentId || '';
    const childFolders = explorerFoldersByParent.get(parentKey) || [];
    const childFiles = explorerFilesByParent.get(parentKey) || [];
    return (
      <>
        {childFolders.map(folder => (
          <div className="tree-group" key={folder.id}>
            <div className="tree-row" style={{ paddingLeft: 8 + depth * 13 }}>
              <button
                className="tree-main"
                onClick={() => {
                  setCurrentFolderId(folder.id);
                  setExpandedFolders(current => {
                    const next = new Set(current);
                    next.has(folder.id)
                      ? next.delete(folder.id)
                      : next.add(folder.id);
                    return next;
                  });
                }}
              >
                {expandedFolders.has(folder.id) ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
                {expandedFolders.has(folder.id) ? (
                  <FolderOpen size={15} />
                ) : (
                  <Folder size={15} />
                )}
                <span>{folder.name}</span>
              </button>
              <button
                className="tree-action"
                title="New file in this folder"
                onClick={() => {
                  setCurrentFolderId(folder.id);
                  setShowNewFile(true);
                  setExpandedFolders(current =>
                    new Set(current).add(folder.id)
                  );
                }}
              >
                <FilePlus2 size={13} />
              </button>
              <button
                className="tree-action"
                title="Create a subfolder"
                onClick={() => {
                  setNewFolderParentId(folder.id);
                  setShowNewFolder(true);
                  setExpandedFolders(current =>
                    new Set(current).add(folder.id)
                  );
                }}
              >
                <FolderPlus size={13} />
              </button>
              <button
                className="tree-action"
                title="Rename folder"
                onClick={() => renameFolder(folder)}
              >
                <Pencil size={12} />
              </button>
              <button
                className="tree-action danger"
                title="Delete folder"
                onClick={() => deleteFolder(folder)}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {expandedFolders.has(folder.id) && (
              <div>{renderExplorer(folder.id, depth + 1)}</div>
            )}
          </div>
        ))}
        {childFiles.map(file => (
          <div
            className={
              'file-row ' + (selectedFile?.id === file.id ? 'selected' : '')
            }
            key={file.id}
            style={{ paddingLeft: 10 + depth * 13 }}
          >
            <button className="file-select" onClick={() => openFile(file)}>
              <FileCode2 size={14} />
              <span>{file.name}</span>
              {dirtyFileIds.has(file.id) && <i className="tab-unsaved" />}
            </button>
            <button
              className="tree-action"
              title="Rename file"
              onClick={() => renameFile(file)}
            >
              <Pencil size={12} />
            </button>
            <button
              className="file-delete"
              title={'Delete ' + file.name}
              onClick={() => deleteFile(file)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </>
    );
  };

  const deleteFile = async (file: ProjectFile) => {
    if (!activeProject) return;
    const confirmed = await askForConfirmation(
      'Delete file?',
      'Delete "' + file.name + '"? This action cannot be undone.'
    );
    if (!confirmed) return;
    if (!(await flushFileSave(file.id))) return;
    try {
      await api.delete(
        '/api/projects/' + activeProject.id + '/files/' + file.id
      );
      delete fileDraftsRef.current[file.id];
      delete pendingSavesRef.current[file.id];
      setDirtyFileIds(current => { const next = new Set(current); next.delete(file.id); return next; });
      setFiles(current => current.filter(item => item.id !== file.id));
      setOpenTabIds(current => current.filter(id => id !== file.id));
      setSelectedFile(current => (current?.id === file.id ? null : current));
      setNotice('File deleted');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error || err?.message || 'Could not delete file.'
      );
    }
  };

  const updateEditor = (value?: string) => {
    if (!selectedFile || !activeProject) return;
    const content = value ?? '';
    const updated = { ...selectedFile, content };
    const fileId = selectedFile.id;
    const projectId = activeProject.id;
    fileDraftsRef.current[fileId] = content;
    pendingSavesRef.current[fileId] = { projectId, content };
    setDirtyFileIds(current => new Set(current).add(fileId));
    setSelectedFile(updated);
    setFiles(current => current.map(item => item.id === updated.id ? updated : item));
    setErrorMessage('');
    setNotice('Unsaved changes…');
    if (saveTimersRef.current[fileId]) clearTimeout(saveTimersRef.current[fileId]);
    saveTimersRef.current[fileId] = setTimeout(() => {
      delete saveTimersRef.current[fileId];
      void flushFileSave(fileId);
    }, 450);
  };

  const loadAssistantStatus = async () => {
    try {
      const response = await api.get('/api/assistant/status');
      setAssistantUsage(response.data.usage ?? 0);
      setAssistantProviders(
        response.data.providers || { gemini: false, groq: false }
      );
    } catch {
      setAssistantUsage(null);
    }
  };

  useEffect(() => {
    if (assistantOpen) void loadAssistantStatus();
  }, [assistantOpen]);

  const askAssistant = async (
    event?: React.FormEvent | React.KeyboardEvent
  ) => {
    event?.preventDefault();
    if (!activeProject || !assistantPrompt.trim() || assistantBusy) return;
    setAssistantBusy(true);
    setAssistantAnswer('');
    setPendingPlan(null);
    try {
      if (assistantMode === 'edit') {
        const response = await api.post('/api/assistant/plan', {
          projectId: activeProject.id,
          selectedFileId: selectedFile?.id,
          message: assistantPrompt.trim(),
          provider: assistantProvider,
        });
        if (typeof response.data.usage === 'number')
          setAssistantUsage(response.data.usage);
        setPendingPlan(response.data);
        if (!response.data.changes?.length)
          setAssistantAnswer(
            'No file changes were proposed. Try a more specific request.'
          );
      } else {
        const response = await api.post('/api/assistant/chat', {
          projectId: activeProject.id,
          selectedFileId: selectedFile?.id,
          message: assistantPrompt.trim(),
          provider: assistantProvider,
        });
        if (typeof response.data.usage === 'number')
          setAssistantUsage(response.data.usage);
        setAssistantAnswer(response.data.answer || 'No answer was returned.');
      }
    } catch (err: any) {
      setAssistantAnswer(
        err?.response?.data?.error ||
          err?.message ||
          'Nova Assistant is unavailable. Please retry.'
      );
    } finally {
      setAssistantBusy(false);
    }
  };

  const approveAssistantPlan = async () => {
    if (!activeProject || !pendingPlan || applyingPlan) return;
    setApplyingPlan(true);
    try {
      const response = await api.post('/api/assistant/apply', {
        projectId: activeProject.id,
        changes: pendingPlan.changes.map(
          ({ fileId, baseContent, content }) => ({
            fileId,
            baseContent,
            content,
          })
        ),
      });
      const updated = response.data.files as ProjectFile[];
      const byId = new Map(updated.map(file => [file.id, file]));
      setFiles(current =>
        current.map(file => (byId.has(file.id) ? byId.get(file.id)! : file))
      );
      setSelectedFile(current =>
        current && byId.has(current.id) ? byId.get(current.id)! : current
      );
      updated.forEach(file => {
        fileDraftsRef.current[file.id] = file.content;
      });
      setDirtyFileIds(current => {
        const next = new Set(current);
        updated.forEach(file => next.delete(file.id));
        return next;
      });
      setPendingPlan(null);
      setNotice('Approved changes applied to workspace');
      setAssistantAnswer(
        'Approved changes are now applied to the actual project files. Review them in the editor.'
      );
    } catch (err: any) {
      setAssistantAnswer(
        err?.response?.data?.error ||
          err?.message ||
          'Could not apply the approved changes.'
      );
    } finally {
      setApplyingPlan(false);
    }
  };

  const copyAssistantAnswer = async () => {
    if (!assistantAnswer) return;
    try {
      await navigator.clipboard.writeText(assistantAnswer);
      setNotice('Assistant response copied');
    } catch {
      setErrorMessage(
        'Clipboard access was blocked. Select and copy the response manually.'
      );
    }
  };

  const copyInvite = async () => {
    if (!activeProject) return;
    try {
      await navigator.clipboard.writeText(activeProject.inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setErrorMessage(
        'Clipboard access was blocked. Copy the invite code manually.'
      );
    }
  };

  const exportProjectZip = async () => {
    if (!activeProject) return;
    try {
      const JSZipModule = JSZip;
      const zip = new JSZipModule();
      const folderPathById = new Map<string, string>();
      const getFolderPath = (
        folderId: string | null | undefined,
        seen = new Set<string>()
      ): string => {
        if (!folderId || seen.has(folderId)) return '';
        const cached = folderPathById.get(folderId);
        if (cached !== undefined) return cached;
        seen.add(folderId);
        const folder = folders.find(item => item.id === folderId);
        if (!folder) return '';
        const parentPath = getFolderPath(folder.parentId, seen);
        const path = parentPath ? parentPath + '/' + folder.name : folder.name;
        folderPathById.set(folderId, path);
        return path;
      };
      folders.forEach(folder => zip.folder(getFolderPath(folder.id)));
      const skippedSecretFiles: string[] = [];
      files.forEach(file => {
        const parentPath = getFolderPath(file.parentId);
        const path = (parentPath ? parentPath + '/' : '') + file.name;
        const lowerName = file.name.toLowerCase();
        const looksSecret =
          (lowerName.startsWith('.env') &&
            lowerName !== '.env.example' &&
            lowerName !== '.env.sample') ||
          lowerName.endsWith('.pem') ||
          lowerName.endsWith('.key') ||
          lowerName === 'id_rsa' ||
          lowerName.includes('service-account') ||
          lowerName === 'credentials.json';
        if (looksSecret) {
          skippedSecretFiles.push(path);
          return;
        }
        zip.file(path, file.content || '');
      });
      zip.file(
        'NOVA-DEPLOYMENT-GUIDE.md',
        [
          '# ' + activeProject.name + ' — Deployment guide',
          '',
          '## Detected project type',
          deploymentProfile.stack,
          '',
          '## Suggested hosting',
          deploymentProfile.recommendation,
          '',
          '## Build command',
          deploymentProfile.buildCommand,
          '',
          '## Before publishing',
          '- Install the dependencies required by this project.',
          '- Configure environment variables in your hosting provider dashboard.',
          '- Never upload real API keys, passwords, tokens, private keys or production .env files.',
          '- Run the project build and test suite locally before production deployment.',
          '- Review the provider build command, output directory, start command and runtime settings.',
          '',
          '## Secret files excluded from this ZIP',
          ...(skippedSecretFiles.length
            ? skippedSecretFiles.map(path => '- ' + path)
            : [
                '- No obvious secret files were detected. Review source code for hard-coded credentials before publishing.',
              ]),
          '',
          'Generated by NOVA IDE Deployment Center.',
        ].join('\\n')
      );
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download =
        (activeProject.name
          .replace(/[^a-z0-9._-]+/gi, '-')
          .replace(/^-|-$/g, '') || 'nova-project') + '.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      setNotice(
        'Deployment ZIP downloaded' +
          (skippedSecretFiles.length
            ? ' · ' + skippedSecretFiles.length + ' secret file(s) excluded'
            : '')
      );
    } catch (err: any) {
      setErrorMessage(
        err?.message || 'Could not export this project as a ZIP file.'
      );
    }
  };

  const startZipImport = () => zipImportRef.current?.click();
  const startFolderImport = () => folderImportRef.current?.click();

  const handleProjectImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
    source: 'zip' | 'folder'
  ) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    if (!selected.length) return;

    let targetProject = activeProject;
    let newProjectName = '';
    if (targetProject) {
      const accepted = window.confirm(
        'Import these files into “' +
          targetProject.name +
          '”? Existing files will be skipped, never overwritten.'
      );
      if (!accepted) return;
    } else {
      const suggested =
        source === 'zip'
          ? selected[0].name.replace(/\\.zip$/i, '')
          : ((selected[0] as any).webkitRelativePath || selected[0].name).split(
              '/'
            )[0];
      const name = window.prompt(
        'Name your imported project',
        suggested.slice(0, 48) || 'Imported project'
      );
      if (!name || !name.trim()) return;
      newProjectName = name.trim().slice(0, 48);
    }

    setImportBusy(true);
    setImportNotice('Preparing project files…');
    setErrorMessage('');
    let createdCount = 0;
    let skippedCount = 0;
    try {
      if (!targetProject) {
        const suggested =
          source === 'zip'
            ? selected[0].name.replace(/\\.zip$/i, '')
            : (
                (selected[0] as any).webkitRelativePath || selected[0].name
              ).split('/')[0];
        const created = await api.post('/api/projects', {
          name: newProjectName,
        });
        targetProject = created.data.project as Project;
        await loadProjects();
        await openProject(targetProject);
        const starter = await api.get('/api/projects/' + targetProject.id);
        for (const file of (starter.data.files || []) as ProjectFile[]) {
          await api.delete(
            '/api/projects/' + targetProject.id + '/files/' + file.id
          );
        }
      }

      const entries: Array<{
        path: string;
        read: () => Promise<string>;
        size: number;
      }> = [];
      if (source === 'zip') {
        const archive = await JSZip.loadAsync(selected[0]);
        for (const [path, item] of Object.entries(archive.files)) {
          if (item.dir) continue;
          const segments = path.replace(/\\\\/g, '/').split('/');
          if (
            segments.some(
              part =>
                !part ||
                [
                  'node_modules',
                  'dist',
                  'build',
                  '.next',
                  '.git',
                  '.svn',
                  '.hg',
                  '.turbo',
                  '.cache',
                  'vendor',
                ].includes(part.toLowerCase())
            )
          ) {
            skippedCount++;
            continue;
          }
          const size = (item as any)._data?.uncompressedSize || 0;
          if (size > 100000) {
            skippedCount++;
            continue;
          }
          entries.push({ path, size, read: () => item.async('string') });
        }
      } else {
        for (const file of selected) {
          const relative = (
            (file as any).webkitRelativePath || file.name
          ).replace(/\\\\/g, '/');
          const path = relative.includes('/')
            ? relative.split('/').slice(1).join('/')
            : relative;
          const segments = path.split('/');
          if (
            !path ||
            segments.some(
              part =>
                !part ||
                [
                  'node_modules',
                  'dist',
                  'build',
                  '.next',
                  '.git',
                  '.svn',
                  '.hg',
                  '.turbo',
                  '.cache',
                  'vendor',
                ].includes(part.toLowerCase())
            )
          ) {
            skippedCount++;
            continue;
          }
          if (file.size > 100000) {
            skippedCount++;
            continue;
          }
          entries.push({ path, size: file.size, read: () => file.text() });
        }
      }

      const binaryExtensions = new Set([
        'png',
        'jpg',
        'jpeg',
        'gif',
        'webp',
        'ico',
        'svgz',
        'pdf',
        'zip',
        'gz',
        '7z',
        'rar',
        'woff',
        'woff2',
        'ttf',
        'otf',
        'mp3',
        'mp4',
        'mov',
        'webm',
        'wav',
        'ogg',
        'exe',
        'dll',
        'so',
        'dylib',
        'bin',
        'psd',
        'sketch',
      ]);
      const normalized = entries
        .map(entry => ({
          ...entry,
          path: entry.path
            .split('/')
            .map(part => part.replace(/[^A-Za-z0-9._-]/g, '_'))
            .filter(Boolean)
            .join('/'),
        }))
        .filter(entry => {
          const name = entry.path.split('/').pop() || '';
          const extension = name.includes('.')
            ? name.split('.').pop()!.toLowerCase()
            : '';
          if (
            !entry.path ||
            name.startsWith('.env') ||
            binaryExtensions.has(extension)
          ) {
            skippedCount++;
            return false;
          }
          return true;
        });
      if (!normalized.length)
        throw new Error(
          'No supported text/source files were found in that import.'
        );

      const projectId = targetProject.id;
      const [projectResponse, folderResponse] = await Promise.all([
        api.get('/api/projects/' + projectId),
        api.get('/api/projects/' + projectId + '/folders'),
      ]);
      const currentFiles = (projectResponse.data.files || []) as ProjectFile[];
      const currentFolders = (folderResponse.data.folders ||
        []) as ProjectFolder[];
      const folderPaths = new Map<string, string | null>();
      const folderPath = (
        folder: ProjectFolder,
        seen = new Set<string>()
      ): string => {
        if (seen.has(folder.id)) return folder.name;
        seen.add(folder.id);
        const parentFolder = currentFolders.find(
          item => item.id === folder.parentId
        );
        return parentFolder
          ? folderPath(parentFolder, seen) + '/' + folder.name
          : folder.name;
      };
      currentFolders.forEach(folder =>
        folderPaths.set(folderPath(folder), folder.id)
      );
      const filePaths = new Set(
        currentFiles.map(file => {
          const parentFolder = currentFolders.find(
            folder => folder.id === file.parentId
          );
          return (
            (parentFolder ? folderPath(parentFolder) + '/' : '') + file.name
          );
        })
      );
      const occupiedFolderPaths = new Set(folderPaths.keys());
      const folderIds = new Map<string, string | null>([['', null]]);
      currentFolders.forEach(folder =>
        folderIds.set(folderPath(folder), folder.id)
      );

      const ensureFolder = async (path: string): Promise<string | null> => {
        if (!path) return null;
        if (folderIds.has(path)) return folderIds.get(path) || null;
        const parts = path.split('/');
        const parentPath = parts.slice(0, -1).join('/');
        const parentId = await ensureFolder(parentPath);
        const name = parts[parts.length - 1];
        const fullPath = path;
        if (filePaths.has(fullPath))
          throw new Error(
            'A file already exists where the folder “' +
              fullPath +
              '” is needed.'
          );
        const response = await api.post(
          '/api/projects/' + projectId + '/folders',
          { name, parentId }
        );
        const folder = response.data.folder as ProjectFolder;
        folderIds.set(path, folder.id);
        occupiedFolderPaths.add(path);
        return folder.id;
      };

      const totalBytes = normalized.reduce((sum, entry) => sum + entry.size, 0);
      if (normalized.length > 500 || totalBytes > 5 * 1024 * 1024)
        throw new Error(
          'Import limit is 500 text files and 5 MB of source content per batch. Files larger than 100 KB and binary assets are not supported yet.'
        );
      for (const entry of normalized) {
        const parts = entry.path.split('/');
        const fileName = parts.pop()!;
        const parentPath = parts.join('/');
        const fullPath = entry.path;
        if (filePaths.has(fullPath) || occupiedFolderPaths.has(fullPath)) {
          skippedCount++;
          continue;
        }
        try {
          const parentId = await ensureFolder(parentPath);
          const content = await entry.read();
          if (content.length > 100000) {
            skippedCount++;
            continue;
          }
          const created = await api.post(
            '/api/projects/' + projectId + '/files',
            { name: fileName, parentId }
          );
          await api.put(
            '/api/projects/' + projectId + '/files/' + created.data.file.id,
            { content }
          );
          filePaths.add(fullPath);
          createdCount++;
        } catch (err: any) {
          if (err?.response?.status === 409) skippedCount++;
          else throw err;
        }
        setImportNotice('Importing… ' + createdCount + ' files added');
      }

      const [freshProject, freshFolders] = await Promise.all([
        api.get('/api/projects/' + projectId),
        api.get('/api/projects/' + projectId + '/folders'),
      ]);
      const refreshedFiles = (freshProject.data.files || []) as ProjectFile[];
      setFiles(refreshedFiles);
      fileDraftsRef.current = Object.fromEntries(
        refreshedFiles.map(file => [file.id, file.content])
      );
      setFolders(freshFolders.data.folders || []);
      setExpandedFolders(
        new Set(
          (freshFolders.data.folders || []).map(
            (folder: ProjectFolder) => folder.id
          )
        )
      );
      if (!selectedFile && refreshedFiles[0]) {
        setSelectedFile(refreshedFiles[0]);
        setOpenTabIds([refreshedFiles[0].id]);
      }
      setNotice(
        'Import complete: ' +
          createdCount +
          ' files added' +
          (skippedCount ? ', ' + skippedCount + ' skipped' : '') +
          '.'
      );
      setImportNotice('Import complete.');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error ||
          err?.message ||
          'Could not import this project. Any files already imported are safe and can be reviewed.'
      );
      setImportNotice('Import stopped.');
    } finally {
      setImportBusy(false);
    }
  };

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    restoreAttemptedRef.current = false;
    setErrorMessage('');
    setNotice('');
    setLoginBusy(true);
    try {
      const response = await api.post('/api/auth/login', {
        username: loginUsername.trim(),
        password: loginPassword,
      });
      setUser(response.data.user);
      setLoginPassword('');
      // Authentication success is communicated by the dashboard transition,
      // not a persistent banner in the workspace UI.
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error ||
          err?.message ||
          'Sign-in failed. Check your details.'
      );
    } finally {
      setLoginBusy(false);
    }
  };

  const createAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setAccountNotice('');
    try {
      const response = await api.post('/api/admin/users', {
        username: newAccountUsername.trim(),
        name: newAccountName.trim() || newAccountUsername.trim(),
        password: newAccountPassword,
      });
      setAdminAccounts(current => [...current, response.data.user]);
      setNewAccountUsername('');
      setNewAccountName('');
      setNewAccountPassword('');
      setAccountNotice('Account created successfully.');
    } catch (err: any) {
      setAccountNotice(
        err?.response?.data?.error ||
          err?.message ||
          'Could not create account.'
      );
    }
  };

  const signOut = async () => {
    const leftWorkspace = await leaveWorkspace();
    if (!leftWorkspace) return;
    try { await api.post('/api/auth/logout'); }
    finally { setUser(null); setProjects([]); setAdminAccounts([]); }
  };

  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => a.name.localeCompare(b.name)),
    [files]  );
  const filesById = useMemo(() => new Map(files.map(file => [file.id, file])), [files]);
  const openTabs = useMemo(() => openTabIds.map(id=>filesById.get(id)).filter((file):file is ProjectFile=>Boolean(file)), [openTabIds,filesById]);
  const quickOpenFiles = useMemo(() => { const query=paletteQuery.trim().toLowerCase(); return files.filter(file=>!query||file.name.toLowerCase().includes(query)).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,60); }, [files,paletteQuery]);
  const filteredPaletteCommands = useMemo(() => { const query=paletteQuery.trim().toLowerCase(); return PALETTE_COMMANDS.filter(command=>!query||command.label.toLowerCase().includes(query)); }, [paletteQuery]);
  const allRolesAccepted =
    teamAssignments.length === 3 &&
    teamAssignments.every(assignment => assignment.status === 'accepted');
  const isProjectOwner = Boolean(
    activeProject &&
    user &&
    (activeProject.ownerId === user.userId ||
      members.some(
        member => member.userId === user.userId && member.role === 'owner'
      ))
  );
  const previewDocument = useMemo(
    () => (previewOpen ? buildPreviewDocument(files) : ''),
    [files, previewRevision, previewOpen]
  );
  const displayName = user?.name || user?.username || 'Developer';
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target?.closest('input, textarea, select, [contenteditable="true"], .monaco-editor')
      );

      if (event.key === 'Escape' && (quickOpenOpen || commandPaletteOpen)) {
        event.preventDefault();
        event.stopPropagation();
        setQuickOpenOpen(false);
        setCommandPaletteOpen(false);
        setPaletteQuery('');
        return;
      }

      // These shortcuts must run before the active-project guard; otherwise
      // the browser handles Ctrl/Cmd+P as Print on the dashboard.
      if (mod && event.shiftKey && key === 'p') {
        event.preventDefault();
        event.stopPropagation();
        setQuickOpenOpen(false);
        setPaletteQuery('');
        setPaletteActiveIndex(0);
        setCommandPaletteOpen(true);
        return;
      }

      if (mod && !event.shiftKey && key === 'p') {
        event.preventDefault();
        event.stopPropagation();
        setCommandPaletteOpen(false);
        setPaletteQuery('');
        setPaletteActiveIndex(0);
        setQuickOpenOpen(true);
        return;
      }

      if (!activeProject) return;

      if (mod && key === 's') {
        event.preventDefault();
        const ids = selectedFile
          ? [selectedFile.id]
          : Object.keys(pendingSavesRef.current);
        void Promise.all(ids.map(id => flushFileSave(id)));
        return;
      }
      if (mod && key === 'b') {
        event.preventDefault();
        setExplorerCollapsed(value => !value);
        return;
      }
      if (mod && key === 'w') {
        if (event.shiftKey) {
          event.preventDefault();
          setSelectedFile(null);
          setOpenTabIds([]);
        } else if (selectedFile) {
          event.preventDefault();
          closeTab(selectedFile.id);
        }
        return;
      }
      if (mod && !event.shiftKey && key === 'n' && !typing) {
        event.preventDefault();
        setShowNewFile(true);
        return;
      }
      if (event.key === 'F5') {
        event.preventDefault();
        if (event.shiftKey) {
          setPreviewOpen(false);
        } else {
          setPreviewOpen(true);
          setPreviewRevision(value => value + 1);
        }
        return;
      }
      if (!typing && event.key === 'F2' && selectedFile) {
        event.preventDefault();
        void renameFile(selectedFile);
        return;
      }
      if (!typing && mod && key === 'f') {
        event.preventDefault();
        document.getElementById('nova-explorer-search')?.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeProject?.id, selectedFile?.id, quickOpenOpen, commandPaletteOpen]);
  const deploymentProfile = useMemo(() => {
    if (!showDeployment) return { stack:'', recommendation:'', buildCommand:'', fileCount:0, folderCount:0, secretFiles:[] as string[], sourceCodeCount:0, envVarNames:[] as string[], manifestPresent:false, manifestValid:true };
    const folderById = new Map(folders.map(folder=>[folder.id,folder]));
    const paths = files.map(file => {
      const parts: string[] = [];
      let parentId = file.parentId || null;
      while (parentId) {
        const folder = folderById.get(parentId);
        if (!folder) break;
        parts.unshift(folder.name);
        parentId = folder.parentId;
      }
      return (parts.length ? parts.join('/') + '/' : '') + file.name;
    });
    const rootNames = new Set(
      paths.filter(path => !path.includes('/')).map(path => path.toLowerCase())
    );
    const packageFile = files.find(
      file => !file.parentId && file.name.toLowerCase() === 'package.json'
    );
    let manifest: any = {};
    let manifestValid = true;
    try {
      manifest =
        packageFile && packageFile.content.trim()
          ? JSON.parse(packageFile.content)
          : {};
    } catch {
      manifestValid = false;
      manifest = {};
    }
    const dependencies = {
      ...(manifest.dependencies || {}),
      ...(manifest.devDependencies || {}),
    };
    const sourceExtensions =
      /\\.(html|css|js|jsx|ts|tsx|mjs|cjs|py|java|go|rs|php|rb|vue|svelte)$/i;
    const sourceCodeFiles = files.filter(
      file => sourceExtensions.test(file.name) && Boolean(file.content?.trim())
    );
    const envVarNames = Array.from(
      new Set(
        files.flatMap(file => {
          const matches =
            file.content?.match(
              /(?:process\\.env\\.|import\\.meta\\.env\\.)([A-Z][A-Z0-9_]{1,})|Deno\\.env\\.get\\(['"]([A-Z][A-Z0-9_]{1,})['"]\\)|os\\.environ\\.get\\(['"]([A-Z][A-Z0-9_]{1,})['"]\\)/g
            ) || [];
          return matches.flatMap(match => {
            const parts = match.match(
              /(?:process\\.env\\.|import\\.meta\\.env\\.)([A-Z][A-Z0-9_]{1,})|Deno\\.env\\.get\\(['"]([A-Z][A-Z0-9_]{1,})['"]\\)|os\\.environ\\.get\\(['"]([A-Z][A-Z0-9_]{1,})['"]\\)/
            );
            return parts
              ? [parts[1] || parts[2] || parts[3]].filter(Boolean)
              : [];
          });
        })
      )
    ).sort();
    let stack = 'Unknown / custom project';
    let recommendation =
      'Review the project files and choose a compatible hosting platform.';
    if (!sourceCodeFiles.length) {
      stack = 'Structure only — source code not added';
      recommendation =
        'Add the application source code before choosing a hosting provider.';
    } else if (dependencies.next) {
      stack = 'Next.js';
      recommendation = 'Vercel or a Node.js hosting provider';
    } else if (dependencies.vite) {
      stack = 'Vite' + (dependencies.react ? ' + React' : '');
      recommendation =
        'Vercel or Netlify for frontend; Render for a separate backend';
    } else if (dependencies.react) {
      stack = 'React';
      recommendation = 'Vercel or Netlify';
    } else if (dependencies.vue) {
      stack = 'Vue';
      recommendation = 'Vercel or Netlify';
    } else if (
      rootNames.has('requirements.txt') ||
      rootNames.has('pyproject.toml')
    ) {
      stack = 'Python';
      recommendation = 'Render or another Python-capable host';
    } else if (rootNames.has('index.html')) {
      stack = 'Static HTML / CSS / JavaScript';
      recommendation = 'Netlify or Vercel';
    } else if (rootNames.has('package.json')) {
      stack = 'Node.js';
      recommendation = 'Render or another Node.js host';
    }
    const buildCommand =
      typeof manifest.scripts?.build === 'string'
        ? 'npm run build'
        : 'No build script detected';
    const secretFiles = paths.filter(path => {
      const name = path.split('/').pop()?.toLowerCase() || '';
      return (
        (name.startsWith('.env') &&
          name !== '.env.example' &&
          name !== '.env.sample') ||
        name.endsWith('.pem') ||
        name.endsWith('.key') ||
        name === 'id_rsa' ||
        name.includes('service-account') ||
        name === 'credentials.json'
      );
    });
    return {
      stack,
      recommendation,
      buildCommand,
      fileCount: files.length,
      folderCount: folders.length,
      secretFiles,
      sourceCodeCount: sourceCodeFiles.length,
      envVarNames,
      manifestPresent: Boolean(packageFile),
      manifestValid,
    };
  }, [files, folders, showDeployment]);

  const loadDeploymentActivity = async () => {
    if (!activeProject) return;
    try {
      const response = await api.get(
        '/api/projects/' + activeProject.id + '/deployment-activity'
      );
      setDeploymentActivity(response.data.activity || []);
    } catch {
      setDeploymentActivity([]);
    }
  };

  const loadNetlifyDeployments = async () => {
    if (!activeProject) return;
    try {
      const response = await api.get(
        '/api/projects/' + activeProject.id + '/netlify/deployments'
      );
      setNetlifyDeployments(response.data.deployments || []);
    } catch {
      setNetlifyDeployments([]);
    }
  };

  const loadRenderWorkspaces = async () => {
    if (!activeProject) return;
    setRenderWorkspaceBusy(true);
    try {
      const response = await api.get(
        '/api/projects/' + activeProject.id + '/render/workspaces'
      );
      const workspaces = response.data.workspaces || [];
      setRenderWorkspaces(workspaces);
      setSelectedRenderOwnerId(current =>
        workspaces.some((workspace: any) => workspace.id === current)
          ? current
          : workspaces[0]?.id || ''
      );
    } catch (err: any) {
      setRenderError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not load Render workspaces.'
      );
    } finally {
      setRenderWorkspaceBusy(false);
    }
  };

  const loadRenderService = async () => {
    if (!activeProject) return;
    setRenderRefreshBusy(true);
    try {
      const response = await api.get(
        '/api/projects/' + activeProject.id + '/render/service'
      );
      setRenderService(response.data.service || null);
      setRenderDeployments(response.data.deployments || []);
    } catch (err: any) {
      setRenderError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not load Render service status.'
      );
    } finally {
      setRenderRefreshBusy(false);
    }
  };

  const loadRenderAvailableServices = async () => {
    if (!activeProject || !isProjectOwner || !selectedRenderOwnerId) {
      setRenderError(
        'Select a Render workspace before searching for existing services.'
      );
      return;
    }
    setRenderAvailableBusy(true);
    setRenderError('');
    setRenderAvailableServices([]);
    setRenderSelectedExistingServiceId('');
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/render/available-services',
        { ownerId: selectedRenderOwnerId }
      );
      const services = response.data.services || [];
      setRenderAvailableServices(services);
      setRenderSelectedExistingServiceId(services[0]?.serviceId || '');
      if (!services.length) {
        setRenderError(
          'No unconnected Render Static Sites were found in this workspace. You can create a new service below.'
        );
      }
    } catch (err: any) {
      setRenderError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not find existing Render services.'
      );
    } finally {
      setRenderAvailableBusy(false);
    }
  };

  const connectExistingRenderService = async () => {
    if (
      !activeProject ||
      !isProjectOwner ||
      !renderSelectedExistingServiceId ||
      renderConnectBusy
    )
      return;
    setRenderConnectBusy(true);
    setRenderError('');
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/render/connect',
        { serviceId: renderSelectedExistingServiceId }
      );
      setRenderService(response.data.service || null);
      setRenderDeployments(response.data.deployments || []);
      setRenderAvailableServices([]);
      setRenderSelectedExistingServiceId('');
      setNotice(
        'Existing Render Static Site connected to this NOVA IDE project. Its live website was not recreated or changed.'
      );
    } catch (err: any) {
      setRenderError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not connect the existing Render service.'
      );
    } finally {
      setRenderConnectBusy(false);
    }
  };

  const resetRenderConnection = async () => {
    if (!activeProject || !isProjectOwner || !renderService || renderResetBusy)
      return;
    const confirmed = window.confirm(
      'Reset the Render connection saved in NOVA IDE? This only removes the project link from NOVA. It will NOT delete your Render service, deployments, or live website.'
    );
    if (!confirmed) return;
    setRenderResetBusy(true);
    setRenderError('');
    try {
      await api.delete('/api/projects/' + activeProject.id + '/render/service');
      setRenderService(null);
      setRenderDeployments([]);
      setRenderRepo('');
      setRenderBranch('main');
      setRenderBuildCommand("echo 'Static site ready'");
      setRenderPublishPath('.');
      setNotice(
        'Render connection reset in NOVA IDE. Your existing Render service and live website are unchanged.'
      );
    } catch (err: any) {
      setRenderError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not reset the saved Render connection.'
      );
    } finally {
      setRenderResetBusy(false);
    }
  };

  const createRenderService = async () => {
    if (!activeProject || !isProjectOwner || !selectedRenderOwnerId) return;
    setRenderCreateBusy(true);
    setRenderError('');
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/render/services',
        {
          repo: renderRepo.trim(),
          branch: renderBranch.trim(),
          ownerId: selectedRenderOwnerId,
          buildCommand: renderBuildCommand.trim(),
          publishPath: renderPublishPath.trim(),
        }
      );
      setRenderService(response.data.service || null);
      setRenderDeployments(response.data.deployments || []);
      setNotice(
        'Render Static Site created. Initial deployment started' +
          (response.data.initialDeploymentId
            ? ' (' + response.data.initialDeploymentId + ')'
            : '') +
          '.'
      );
    } catch (err: any) {
      setRenderError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not create the Render Static Site.'
      );
    } finally {
      setRenderCreateBusy(false);
    }
  };

  const triggerRenderDeploy = async () => {
    if (!activeProject || !isProjectOwner || !renderService) return;
    setRenderDeployBusy(true);
    setRenderError('');
    try {
      const response = await api.post(
        '/api/projects/' +
          activeProject.id +
          '/render/services/' +
          encodeURIComponent(renderService.serviceId) +
          '/deploy',
        {}
      );
      setNotice(
        'Render deployment queued: ' +
          (response.data.deployment?.deploymentId || 'request accepted')
      );
      await loadRenderService();
    } catch (err: any) {
      setRenderError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not trigger a Render deployment.'
      );
    } finally {
      setRenderDeployBusy(false);
    }
  };

  const deployDraftToNetlify = async () => {
    if (!activeProject || !isProjectOwner || !files.length) return;
    setNetlifyDeployBusy(true);
    setNetlifyDeployError('');
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/netlify/deploy',
        {}
      );
      const deployment = response.data.deployment;
      setNetlifyDeployments(current =>
        [
          deployment,
          ...current.filter(
            item => item.deploymentId !== deployment.deploymentId
          ),
        ].slice(0, 10)
      );
      setNotice(
        'Netlify draft deployment started' +
          (deployment.url ? ': ' + deployment.url : '')
      );
      if (!response.data.historySaved) {
        setNetlifyDeployError(
          'The deployment started, but NOVA could not save its history record.'
        );
      }
    } catch (err: any) {
      setNetlifyDeployError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not start a Netlify draft deployment.'
      );
    } finally {
      setNetlifyDeployBusy(false);
    }
  };

  const refreshNetlifyDeployment = async (deploymentId: string) => {
    if (!activeProject || netlifyRefreshBusy) return;
    setNetlifyRefreshBusy(deploymentId);
    setNetlifyDeployError('');
    try {
      const response = await api.post(
        '/api/projects/' +
          activeProject.id +
          '/netlify/deployments/' +
          encodeURIComponent(deploymentId) +
          '/refresh',
        {}
      );
      const deployment = response.data.deployment;
      setNetlifyDeployments(current =>
        current.map(item =>
          item.deploymentId === deployment.deploymentId ? deployment : item
        )
      );
    } catch (err: any) {
      setNetlifyDeployError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not refresh the Netlify deployment status.'
      );
    } finally {
      setNetlifyRefreshBusy(null);
    }
  };

  const loadVercelDeployments = async () => {
    if (!activeProject) return;
    try {
      const response = await api.get(
        '/api/projects/' + activeProject.id + '/vercel/deployments'
      );
      setVercelDeployments(response.data.deployments || []);
    } catch {
      setVercelDeployments([]);
    }
  };

  const deployPreviewToVercel = async () => {
    if (!activeProject || !isProjectOwner || !files.length) return;
    setVercelDeployBusy(true);
    setVercelDeployError('');
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/vercel/deploy',
        {}
      );
      const deployment = response.data.deployment;
      setVercelDeployments(current =>
        [
          deployment,
          ...current.filter(
            item => item.deploymentId !== deployment.deploymentId
          ),
        ].slice(0, 10)
      );
      setNotice(
        'Vercel Preview deployment started' +
          (deployment.url ? ': ' + deployment.url : '')
      );
      if (!response.data.historySaved) {
        setVercelDeployError(
          'The deployment started, but NOVA could not save its history record.'
        );
      }
    } catch (err: any) {
      setVercelDeployError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not start a Vercel Preview deployment.'
      );
    } finally {
      setVercelDeployBusy(false);
    }
  };

  const refreshVercelDeployment = async (deploymentId: string) => {
    if (!activeProject || vercelRefreshBusy) return;
    setVercelRefreshBusy(deploymentId);
    setVercelDeployError('');
    try {
      const response = await api.post(
        '/api/projects/' +
          activeProject.id +
          '/vercel/deployments/' +
          encodeURIComponent(deploymentId) +
          '/refresh',
        {}
      );
      const deployment = response.data.deployment;
      setVercelDeployments(current =>
        current.map(item =>
          item.deploymentId === deployment.deploymentId ? deployment : item
        )
      );
    } catch (err: any) {
      setVercelDeployError(
        err?.response?.data?.error ||
          err?.message ||
          'Could not refresh the Vercel deployment status.'
      );
    } finally {
      setVercelRefreshBusy(null);
    }
  };

  const verifyDeploymentIntegrations = async () => {
    if (!activeProject || !isProjectOwner) return;
    setIntegrationVerifyBusy(true);
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/deployment-integrations/verify',
        {}
      );
      const next: Record<
        string,
        { configured: boolean; connected: boolean; message: string }
      > = {};
      (response.data.providers || []).forEach((item: any) => {
        next[item.provider] = item;
      });
      setDeploymentIntegrations(next);
      const connected = Object.values(next).filter(
        item => item.connected
      ).length;
      setNotice(connected + ' of 4 provider credentials verified');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error ||
          err?.message ||
          'Could not verify provider credentials.'
      );
    } finally {
      setIntegrationVerifyBusy(false);
    }
  };

  const pushProjectToGitHub = async () => {
    if (!activeProject || !isProjectOwner || !githubRepositoryUrl.trim())
      return;
    setGithubPushBusy(true);
    setGithubPushResult(null);
    try {
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/github/push',
        {
          repositoryUrl: githubRepositoryUrl.trim(),
          branch: githubBranch.trim(),
          readme: githubReadme,
          gitignore: githubGitignore,
          license: githubLicenseChoice === 'MIT' ? githubLicenseText : '',
        }
      );
      setGithubPushResult(response.data);
      setNotice(
        'Pushed ' +
          response.data.fileCount +
          ' files to ' +
          response.data.repositoryUrl
      );
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error ||
          err?.message ||
          'Could not push project files to GitHub.'
      );
    } finally {
      setGithubPushBusy(false);
    }
  };

  const runDeploymentCheck = async () => {
    if (!activeProject) return;
    setDeploymentCheckBusy(true);
    try {
      const checks = [
        {
          name: 'Workspace files',
          status: deploymentProfile.fileCount > 0 ? 'passed' : 'blocked',
          detail: deploymentProfile.fileCount + ' file(s) found',
        },
        {
          name: 'Application source',
          status: deploymentProfile.sourceCodeCount > 0 ? 'passed' : 'blocked',
          detail:
            deploymentProfile.sourceCodeCount > 0
              ? deploymentProfile.sourceCodeCount + ' non-empty source file(s)'
              : 'No non-empty source-code files found',
        },
        {
          name: 'Package manifest',
          status:
            !deploymentProfile.manifestPresent ||
            deploymentProfile.manifestValid
              ? 'passed'
              : 'warning',
          detail: !deploymentProfile.manifestPresent
            ? 'No root package.json detected'
            : deploymentProfile.manifestValid
              ? 'package.json is valid JSON'
              : 'package.json could not be parsed',
        },
        {
          name: 'Secret-file scan',
          status: deploymentProfile.secretFiles.length ? 'warning' : 'passed',
          detail: deploymentProfile.secretFiles.length
            ? deploymentProfile.secretFiles.length +
              ' likely secret file(s) need review'
            : 'No obvious secret filenames found',
        },
        {
          name: 'Environment variables',
          status: deploymentProfile.envVarNames.length ? 'review' : 'passed',
          detail: deploymentProfile.envVarNames.length
            ? deploymentProfile.envVarNames.length +
              ' variable name(s) detected; values are not stored in NOVA'
            : 'No environment variable references detected',
        },
      ];
      const status = checks.some(item => item.status === 'blocked')
        ? 'blocked'
        : checks.some(
              item => item.status === 'warning' || item.status === 'review'
            )
          ? 'review'
          : 'ready_for_build';
      const summary =
        status === 'blocked'
          ? 'Preflight blocked: add source code before a real build can run.'
          : status === 'review'
            ? 'Preflight needs review before a real build.'
            : 'Static preflight passed. A real provider build has not run.';
      const response = await api.post(
        '/api/projects/' + activeProject.id + '/deployment-activity',
        {
          status,
          summary,
          stack: deploymentProfile.stack,
          checks,
          sourceCodeCount: deploymentProfile.sourceCodeCount,
        }
      );
      setDeploymentActivity(current =>
        [response.data.activity, ...current].slice(0, 8)
      );
      setNotice('Deployment readiness check saved');
    } catch (err: any) {
      setErrorMessage(
        err?.response?.data?.error ||
          err?.message ||
          'Could not save deployment check.'
      );
    } finally {
      setDeploymentCheckBusy(false);
    }
  };

  const downloadEnvTemplate = () => {
    if (!deploymentProfile.envVarNames.length) return;
    const content =
      deploymentProfile.envVarNames.map(name => name + '=').join('\\n') + '\\n';
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '.env.example';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    setNotice('.env.example template downloaded');
  };

  if (authLoading) {
    return (
      <div className="auth-screen">
        <div className="loader-orbit" />
        <p>Preparing your workspace…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <main className="auth-screen">
        <div className="auth-glow" />
        <section className="auth-story">
          <div className="auth-story-brand">
            <div className="brand-mark small">
              <Code2 size={18} />
            </div>
            <span>
              nova<span className="brand-light">ide</span>
            </span>
          </div>
          <div className="auth-story-copy">
            <span className="eyebrow">A WORKSPACE FOR REAL WORK</span>
            <h2>
              Build with focus.
              <br />
              <em>Ship together.</em>
            </h2>
            <p>
              Your team's code, projects and live collaboration — in one calm,
              reliable workspace.
            </p>
          </div>
          <div className="auth-story-foot">
            <span className="status-dot" /> Private team workspace{' '}
            <span className="story-separator">·</span> Up to 3 collaborators
          </div>
        </section>
        <form className="auth-card" onSubmit={signIn}>
          <div className="auth-form-heading">
            <span className="eyebrow">ACCOUNT ACCESS</span>
            <h1>Welcome back</h1>
          </div>
          <p className="auth-copy">
            Sign in with your Nova IDE username and password.
          </p>
          <label className="auth-label" htmlFor="nova-username">
            Username
          </label>
          <input
            id="nova-username"
            className="auth-input"
            value={loginUsername}
            onChange={event => setLoginUsername(event.target.value)}
            autoComplete="username"
            placeholder="Your administrator username"
            required
          />
          <label className="auth-label" htmlFor="nova-password">
            Password
          </label>
          <input
            id="nova-password"
            className="auth-input"
            type="password"
            value={loginPassword}
            onChange={event => setLoginPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="Your password"
            required
          />
          <button
            className="primary-button sign-in-button"
            type="submit"
            disabled={loginBusy}
          >
            {loginBusy ? 'Signing in…' : 'Sign in to Nova IDE'}
            <ArrowLeft className="button-arrow" size={17} />
          </button>
          {errorMessage && <p className="error-text">{errorMessage}</p>}
          <div className="auth-foot">
            <span className="status-dot" /> Admin-provisioned accounts only ·
            Secure sessions
          </div>
        </form>
      </main>
    );
  }

  if (!activeProject) {
    return (
      <main className="dashboard-shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark small">
              <Code2 size={19} />
            </div>
            <span>
              nova<span className="brand-light">ide</span>
            </span>
          </div>
          <div className="topbar-right">
            <div className="avatar">
              {displayName.slice(0, 1).toUpperCase()}
            </div>
            <span className="user-label">{displayName}</span>
            <button className="icon-button" title="Sign out" onClick={signOut}>
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <section className="dashboard-content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">YOUR DEVELOPMENT SPACE</div>
              <h1>Good to see you, {displayName}.</h1>
              <p>Pick up where your team left off, or start something new.</p>
            </div>
            <div className="connection-pill">
              <span className={'status-dot ' + connectionState} />{' '}
              {connectionState === 'connected'
                ? 'Live connection'
                : 'Connecting'}
            </div>
          </div>
          {errorMessage && (
            <div className="alert error-alert">
              {errorMessage}
              <button onClick={() => setErrorMessage('')}>
                <X size={15} />
              </button>
            </div>
          )}
          {user.role === 'admin' && (
            <section className="admin-card">
              <div className="admin-card-heading">
                <div>
                  <div className="eyebrow">ADMINISTRATION</div>
                  <h2>Manage accounts</h2>
                  <p>Create login accounts for new Nova IDE teammates.</p>
                </div>
                <span className="admin-tag">ADMIN</span>
              </div>
              <form className="admin-create-form" onSubmit={createAccount}>
                <input
                  value={newAccountUsername}
                  onChange={event => setNewAccountUsername(event.target.value)}
                  placeholder="New username"
                  autoComplete="off"
                  required
                />
                <input
                  value={newAccountName}
                  onChange={event => setNewAccountName(event.target.value)}
                  placeholder="Display name (optional)"
                  autoComplete="off"
                />
                <input
                  type="password"
                  value={newAccountPassword}
                  onChange={event => setNewAccountPassword(event.target.value)}
                  placeholder="Temporary password (12+ characters)"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
                <button className="primary-button" type="submit">
                  <Plus size={16} /> Create account
                </button>
              </form>
              {accountNotice && (
                <p className="account-notice">{accountNotice}</p>
              )}
              <div className="admin-account-list">
                <strong>Created accounts ({adminAccounts.length})</strong>
                {adminAccounts.length === 0 ? (
                  <span>No additional accounts created yet.</span>
                ) : (
                  adminAccounts.map(account => (
                    <div className="admin-account-row" key={account.userId}>
                      <span>{account.username}</span>
                      <small>
                        {account.name} · {account.role}
                      </small>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}
          <div className="project-actions">
            <section className="action-card import-card">
              <div className="action-icon blue">
                <Upload size={21} />
              </div>
              <h2>Import an existing project</h2>
              <p>
                Bring a project from your computer into a fresh NOVA workspace.
              </p>
              <div className="field-row">
                <button
                  type="button"
                  className="primary-button"
                  onClick={startZipImport}
                  disabled={importBusy}
                >
                  <Upload size={15} /> Import ZIP
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={startFolderImport}
                  disabled={importBusy}
                >
                  <Folder size={15} /> Import folder
                </button>
              </div>
              {importNotice && (
                <small className="import-notice">{importNotice}</small>
              )}
              <input
                ref={zipImportRef}
                className="hidden-import-input"
                type="file"
                accept=".zip,application/zip"
                onChange={event => handleProjectImport(event, 'zip')}
              />
              <input
                ref={folderImportRef}
                className="hidden-import-input"
                type="file"
                multiple
                {...({ webkitdirectory: '', directory: '' } as any)}
                onChange={event => handleProjectImport(event, 'folder')}
              />
            </section>
            <form className="action-card create-card" onSubmit={createProject}>
              <div className="action-icon purple">
                <FolderPlus size={21} />
              </div>
              <h2>Create a project</h2>
              <p>Start a shared workspace and invite two teammates.</p>
              <div className="field-row">
                <input
                  value={projectName}
                  onChange={e => setProjectName(e.target.value)}
                  placeholder="e.g. My first website"
                  maxLength={48}
                />
                <button
                  className="primary-button"
                  disabled={busy || !projectName.trim()}
                >
                  <Plus size={17} /> Create
                </button>
              </div>
            </form>
            <form className="action-card join-card" onSubmit={joinProject}>
              <div className="action-icon blue">
                <Users size={21} />
              </div>
              <h2>Join a project</h2>
              <p>Enter the invite code shared by your project owner.</p>
              <div className="field-row">
                <input
                  value={joinCode}
                  onChange={e => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="6-character invite code"
                  maxLength={6}
                />
                <button
                  className="secondary-button"
                  disabled={busy || joinCode.trim().length < 6}
                >
                  <Send size={16} /> Join
                </button>
              </div>
            </form>
          </div>
          <div className="section-heading">
            <div>
              <h2>Your projects</h2>
              <span>
                {projects.length} workspace{projects.length === 1 ? '' : 's'}
              </span>
            </div>
            <button
              className="quiet-button"
              onClick={() =>
                loadProjects().catch(() => setErrorMessage('Refresh failed.'))
              }
            >
              <RefreshCw size={15} /> Refresh
            </button>
          </div>
          {notice && <div className="alert success-alert">{notice}</div>}
          {loading ? (
            <div className="empty-state">Loading workspace…</div>
          ) : projects.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">
                <Folder size={25} />
              </div>
              <strong>No projects yet</strong>
              <span>
                Create your first workspace or join one with an invite code.
              </span>
            </div>
          ) : (
            <div className="project-grid">
              {projects.map(project => (
                <div className="project-tile-wrap" key={project.id}>
                  <div
                    className="project-tile"
                    role="button"
                    tabIndex={0}
                    onClick={() => void openProject(project)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void openProject(project);
                      }
                    }}
                  >
                    <div className="tile-top">
                      <div className="folder-tile">
                        <Folder size={21} />
                      </div>
                      <span className="tile-open">
                        Open <ArrowLeft size={14} />
                      </span>
                    </div>
                    <strong>{project.name}</strong>
                    <span className="tile-meta">
                      <Users size={14} /> Shared workspace <span>·</span>{' '}
                      <span className="code-label">{project.inviteCode}</span>
                    </span>
                  </div>
                  {project.ownerId === user?.userId && (
                    <button
                      className="project-delete-button"
                      title="Delete project"
                      aria-label={'Delete project ' + project.name}
                      disabled={busy}
                      onClick={event => {
                        event.preventDefault();
                        event.stopPropagation();
                        void deleteProject(project);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="dashboard-note">
            <Activity size={16} /> Each workspace supports its owner and up to
            two invited teammates.
          </div>
        </section>
        {confirmDialog && (
          <div
            className="nova-dialog-backdrop"
            onMouseDown={event => {
              if (event.target === event.currentTarget) closeConfirmation(false);
            }}
          >
            <section
              className="nova-confirm-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="nova-dashboard-confirm-title"
            >
              <div className="nova-confirm-icon">
                <AlertTriangle size={30} strokeWidth={2.2} />
              </div>
              <h2 id="nova-dashboard-confirm-title">{confirmDialog.title}</h2>
              <p>{confirmDialog.message}</p>
              <div className="nova-confirm-actions">
                <button
                  className="secondary-button"
                  onClick={() => closeConfirmation(false)}
                >
                  Cancel
                </button>
                <button
                  className="nova-warning-button"
                  onClick={() => closeConfirmation(true)}
                >
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="ide-shell">
      <input
        ref={zipImportRef}
        className="hidden-import-input"
        type="file"
        accept=".zip,application/zip"
        onChange={event => handleProjectImport(event, 'zip')}
      />
      <input
        ref={folderImportRef}
        className="hidden-import-input"
        type="file"
        multiple
        {...({ webkitdirectory: '', directory: '' } as any)}
        onChange={event => handleProjectImport(event, 'folder')}
      />
      <header className="ide-topbar">
        <div className="brand">
          <div className="brand-mark small">
            <Code2 size={19} />
          </div>
          <span>
            nova<span className="brand-light">ide</span>
          </span>
          <span className="topbar-divider">/</span>
          <button className="project-switch" onClick={leaveWorkspace}>
            {activeProject.name}
            <ChevronDown size={15} />
          </button>
        </div>
        <div className="ide-top-right">
          <div className="connection-pill">
            <span className={'status-dot ' + connectionState} />{' '}
            {connectionState === 'connected' ? 'Live' : 'Reconnecting'}
          </div>
          <button className={'preview-toggle '+(!explorerCollapsed?'active':'')} title="Toggle Explorer (Ctrl/Cmd+B)" aria-label="Toggle file explorer" aria-pressed={!explorerCollapsed} onClick={()=>setExplorerCollapsed(v=>!v)}><FolderOpen size={15}/><span>Explorer</span></button>
          <button
            className={'preview-toggle ' + (previewOpen ? 'active' : '')}
            onClick={() => setPreviewOpen(value => !value)}
          >
            <Eye size={15} /> {previewOpen ? 'Hide preview' : 'Preview'}
          </button>
          <button
            className="preview-toggle import-project-button"
            onClick={startZipImport}
            disabled={importBusy}
            title="Import a ZIP into this workspace"
          >
            <Upload size={15} />
            <span>Import ZIP</span>
          </button>
          <button
            className="preview-toggle import-project-button"
            onClick={startFolderImport}
            disabled={importBusy}
            title="Import a local folder into this workspace"
          >
            <Folder size={15} />
            <span>Import folder</span>
          </button>
          <button
            className={'preview-toggle ' + (showDeployment ? 'active' : '')}
            onClick={() => {
              const next = !showDeployment;
              setShowDeployment(next);
              if (next) {
                loadDeploymentActivity();
                loadVercelDeployments();
                loadNetlifyDeployments();
                loadRenderWorkspaces();
                loadRenderService();
              }
              setAssistantOpen(false);
              setShowMembers(false);
            }}
            title="Open Deployment Center"
          >
            <Activity size={15} />
            <span>Deploy</span>
          </button>
          <button
            className={'preview-toggle ' + (assistantOpen ? 'active' : '')}
            onClick={() => setAssistantOpen(value => !value)}
          >
            <Bot size={15} /> Assistant
          </button>
          <button
            className="members-button"
            onClick={() => setShowMembers(!showMembers)}
          >
            <Users size={16} />
            <span>{members.length}/3</span>
            <div className="avatar-stack">
              {members.slice(0, 3).map(member => (
                <span className="mini-avatar" key={member.userId}>
                  {member.name.slice(0, 1).toUpperCase()}
                </span>
              ))}
            </div>
          </button>
          <button
            className="icon-button"
            title="Back to projects"
            onClick={leaveWorkspace}
          >
            <ArrowLeft size={17} />
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="activity-rail">
          <div className="rail-active">
            <Code2 size={20} />
          </div>
          <div className="rail-spacer" />
          <button title="Settings" className="rail-button">
            <Settings2 size={19} />
          </button>
          <button title="Sign out" className="rail-button" onClick={signOut}>
            <LogOut size={19} />
          </button>
        </aside>
        <aside className={'file-sidebar'+(explorerCollapsed?' collapsed':'')}>
          <div className="sidebar-heading">
            <span>EXPLORER</span>
            <div className="explorer-actions">
              <button
                title="New file at selected location"
                onClick={() => setShowNewFile(true)}
              >
                <FilePlus2 size={15} />
              </button>
              <button
                title="New root folder"
                onClick={() => {
                  setNewFolderParentId(null);
                  setShowNewFolder(true);
                }}
              >
                <FolderPlus size={15} />
              </button>
            </div>
          </div>
          <div className="project-folder">
            <ChevronDown size={14} />
            <Folder size={15} />
            <span>{activeProject.name.toUpperCase()}</span>
            <button
              title="Create file in root"
              onClick={() => {
                setCurrentFolderId(null);
                setShowNewFile(true);
              }}
            >
              <Plus size={15} />
            </button>
          </div>
          {showNewFolder && (
            <form className="new-file-form" onSubmit={createFolder}>
              <input
                autoFocus
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                placeholder="Folder name"
              />
              <button disabled={busy || !newFolderName.trim()}>
                <Check size={14} />
              </button>
              <button type="button" onClick={() => setShowNewFolder(false)}>
                <X size={14} />
              </button>
            </form>
          )}
          {showNewFile && (
            <form className="new-file-form" onSubmit={createFile}>
              <input
                autoFocus
                value={newFileName}
                onChange={e => setNewFileName(e.target.value)}
                placeholder="filename.js"
              />
              <button disabled={busy || !newFileName.trim()}>
                <Check size={14} />
              </button>
              <button type="button" onClick={() => setShowNewFile(false)}>
                <X size={14} />
              </button>
            </form>
          )}
          <div className="explorer-search">
            <Search size={14} />
            <input
              id="nova-explorer-search"
              value={explorerQuery}
              onChange={event => setExplorerQuery(event.target.value)}
              placeholder="Find a file…"
              aria-label="Find a file"
            />
          </div>
          <div className="file-list">
            {renderExplorer(null, 0)}
            {folders.length === 0 && files.length === 0 && (
              <div className="tree-empty">
                No files yet. Create a folder or file to begin.
              </div>
            )}
          </div>
          <div className="sidebar-bottom">
            <span className="status-dot" /> Workspace synced
          </div>
        </aside>
        <section className="editor-panel">
          <div className="editor-tabs" role="tablist" aria-label="Open files">
            {openTabs.map(file => (
              <div
                className={
                  'editor-tab ' + (selectedFile?.id === file.id ? 'active' : '')
                }
                key={file.id}
              >
                <button className="tab-open" role="tab" aria-selected={selectedFile?.id===file.id} aria-label={'Open '+file.name} onClick={()=>openFile(file)}>
                  <FileCode2 size={14} />
                  {file.name}
                  {dirtyFileIds.has(file.id) && <i className="tab-unsaved" />}
                </button>
                <button
                  className="tab-close"
                  title={'Close ' + file.name}
                  aria-label={'Close ' + file.name}
                  onClick={() => closeTab(file.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {openTabs.length === 0 && (
              <div className="editor-tab muted">No file open</div>
            )}
            <div className="editor-tab-spacer" />
            <span className="save-label" role="status" aria-live="polite">
              {notice ||
                (selectedFile && dirtyFileIds.has(selectedFile.id)
                  ? 'Unsaved changes'
                  : 'Ready')}
            </span>
          </div>
          {selectedFile ? (
            <div className="monaco-wrap">
              <Editor
                height="100%"
                language={languageFor(selectedFile.name)}
                theme="vs-dark"
                value={selectedFile.content}
                onChange={updateEditor}
                options={{
                  ariaLabel: 'Code editor',
                  fontSize: 14,
                  minimap: { enabled: false },
                  formatOnPaste: true,
                  formatOnType: true,
                  autoIndent: 'full',
                  tabCompletion: 'on',
                  quickSuggestions: true,
                  suggestOnTriggerCharacters: true,
                  bracketPairColorization: { enabled: true },
                  guides: { bracketPairs: true, indentation: true },
                  autoClosingBrackets: 'always',
                  autoClosingQuotes: 'always',
                  matchBrackets: 'always',
                  lineNumbers: 'on',
                  renderLineHighlight: 'all',
                  largeFileOptimizations: true,
                  stickyScroll: { enabled: true },
                  padding: { top: 18 },
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  fontFamily: 'JetBrains Mono, Consolas, monospace',
                  tabSize: 2,
                }}
              />
            </div>
          ) : (
            <div className="editor-empty">
              <FileCode2 size={30} />
              <strong>Select a file to start coding</strong>
              <span>Choose a file from the explorer or create a new one.</span>
            </div>
          )}
          <footer className="editor-status">
            <span>
              <span className="status-dot" />{' '}
              {connectionState === 'connected' ? 'Connected' : 'Offline'}
            </span>
            <span>
              {selectedFile ? languageFor(selectedFile.name) : 'Plain text'}
            </span>
            <span>UTF-8</span>
            <span>Spaces: 2</span>
          </footer>
        </section>
        {previewOpen && (
          <aside className="preview-panel">
            <div className="preview-header">
              <div>
                <span className="eyebrow">LOCAL RENDER</span>
                <strong>Live preview</strong>
              </div>
              <div className="preview-actions">
                <button
                  title="Refresh preview"
                  onClick={() => setPreviewRevision(value => value + 1)}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  title="Close preview"
                  onClick={() => setPreviewOpen(false)}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
            <iframe
              key={previewRevision}
              className="preview-frame"
              title="Project live preview"
              sandbox="allow-scripts"
              srcDoc={previewDocument}
            />
            <div className="preview-foot">
              <span className="status-dot" /> Preview updates as you edit root
              index.html, style.css and script.js
            </div>
          </aside>
        )}
        {assistantOpen && (
          <aside className="assistant-panel">
            <div className="assistant-panel-head">
              <div>
                <span className="eyebrow">NOVA INTELLIGENCE</span>
                <strong>
                  <Bot size={16} /> Code assistant
                </strong>
              </div>
              <button
                className="icon-button"
                title="Close assistant"
                onClick={() => setAssistantOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <p className="assistant-intro">
              Ask questions or let Nova prepare edits to your real project
              files. Nothing changes until you approve a proposal.
            </p>
            <div className="assistant-provider-row">
              <label htmlFor="assistant-provider">AI engine</label>
              <select
                id="assistant-provider"
                value={assistantProvider}
                onChange={event =>
                  setAssistantProvider(
                    event.target.value as 'auto' | 'gemini' | 'groq'
                  )
                }
              >
                <option value="auto">Auto · Gemini → Groq</option>
                <option value="gemini">Gemini first</option>
                <option value="groq">Groq first</option>
              </select>
            </div>
            <div className="assistant-usage-row">
              <span>
                <i
                  className={assistantProviders.gemini ? 'provider-ready' : ''}
                />{' '}
                Gemini {assistantProviders.gemini ? 'ready' : 'not configured'}{' '}
                <i
                  className={assistantProviders.groq ? 'provider-ready' : ''}
                />{' '}
                Groq {assistantProviders.groq ? 'ready' : 'not configured'}
              </span>
              <strong>
                {assistantUsage === null
                  ? 'Usage unavailable'
                  : assistantUsage + ' requests today (UTC)'}
              </strong>
            </div>
            <div className="assistant-mode-switch">
              <button
                type="button"
                className={assistantMode === 'chat' ? 'selected' : ''}
                onClick={() => {
                  setAssistantMode('chat');
                  setPendingPlan(null);
                }}
              >
                Ask
              </button>
              <button
                type="button"
                className={assistantMode === 'edit' ? 'selected' : ''}
                onClick={() => {
                  setAssistantMode('edit');
                  setPendingPlan(null);
                  setAssistantAnswer('');
                }}
              >
                Edit with approval
              </button>
            </div>
            {selectedFile && (
              <div className="assistant-context">
                <FileCode2 size={13} /> Context: {selectedFile.name}
              </div>
            )}
            <div className="assistant-answer" aria-live="polite">
              {assistantBusy ? (
                <div className="assistant-loading">
                  <span className="status-dot connecting" />{' '}
                  {assistantMode === 'edit'
                    ? 'Preparing a change proposal…'
                    : 'Reviewing your project…'}
                </div>
              ) : pendingPlan ? (
                <div className="change-review">
                  <div className="change-review-title">
                    <Check size={15} /> Review proposed changes
                  </div>
                  <p>{pendingPlan.summary}</p>
                  {pendingPlan.changes.map(change => (
                    <div className="change-file" key={change.fileId}>
                      <strong>
                        <FileCode2 size={13} /> {change.fileName}
                      </strong>
                      <span>{change.reason}</span>
                      <div className="change-stats">
                        <span>
                          {change.baseContent.split('\n').length} original lines
                        </span>
                        <span>→</span>
                        <span>
                          {change.content.split('\n').length} proposed lines
                        </span>
                      </div>
                      <details>
                        <summary>Inspect full proposed code</summary>
                        <pre>{change.content}</pre>
                      </details>
                    </div>
                  ))}
                  <div className="approval-warning">
                    No code has changed yet. Approving writes these files to the
                    shared workspace.
                  </div>
                  <div className="approval-actions">
                    <button
                      className="quiet-button"
                      disabled={applyingPlan}
                      onClick={() => setPendingPlan(null)}
                    >
                      Reject
                    </button>
                    <button
                      className="primary-button"
                      disabled={applyingPlan}
                      onClick={approveAssistantPlan}
                    >
                      <Check size={14} />{' '}
                      {applyingPlan ? 'Applying…' : 'Approve & apply'}
                    </button>
                  </div>
                </div>
              ) : assistantAnswer ? (
                <>
                  <pre>{assistantAnswer}</pre>
                  <button
                    className="quiet-button"
                    onClick={copyAssistantAnswer}
                  >
                    <Copy size={13} /> Copy response
                  </button>
                </>
              ) : (
                <div className="assistant-empty">
                  <Bot size={24} />
                  <strong>
                    {assistantMode === 'edit'
                      ? 'Describe the change you want'
                      : 'What are we building?'}
                  </strong>
                  <span>
                    {assistantMode === 'edit'
                      ? 'Example: Add form validation and improve the empty state.'
                      : 'Try “Review this project for bugs” or “Explain the selected file”.'}
                  </span>
                </div>
              )}
            </div>
            <form className="assistant-form" onSubmit={askAssistant}>
              <textarea
                value={assistantPrompt}
                onChange={event => setAssistantPrompt(event.target.value)}
                placeholder={
                  assistantMode === 'edit'
                    ? 'Describe the code change you want…'
                    : 'Ask about your code…'
                }
                maxLength={6000}
                rows={4}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void askAssistant();
                  }
                }}
              />
              <div>
                <span>{assistantPrompt.length}/6000</span>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={assistantBusy || !assistantPrompt.trim()}
                >
                  <Send size={14} />{' '}
                  {assistantBusy
                    ? 'Thinking…'
                    : assistantMode === 'edit'
                      ? 'Prepare changes'
                      : 'Ask Nova'}
                </button>
              </div>
            </form>
            <div className="assistant-disclaimer">
              {assistantMode === 'edit'
                ? 'Approval required. Nova checks that source files have not changed before applying your approved proposal.'
                : 'Answers are advisory. Switch to Edit with approval to prepare real file changes.'}
            </div>
          </aside>
        )}
        {showDeployment && (
          <>
            <button
              className="panel-scrim"
              onClick={() => setShowDeployment(false)}
              aria-label="Close Deployment Center"
            />
            <aside className="deployment-panel">
              <div className="deployment-panel-head">
                <div>
                  <span className="eyebrow">RELEASE WORKSPACE</span>
                  <h3>Deployment Center</h3>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setShowDeployment(false)}
                  aria-label="Close Deployment Center"
                >
                  <X size={17} />
                </button>
              </div>
              <p className="deployment-intro">
                Review project readiness, verify shared provider credentials,
                inspect deployment activity and export a safe package.
                Credentials stay on NOVA's backend and are never sent to
                teammates' browsers.
              </p>
              <section className="deployment-project-card">
                <span className="deployment-label">CURRENT PROJECT</span>
                <strong>{activeProject.name}</strong>
                <div className="deployment-stats">
                  <span>
                    <FileCode2 size={13} /> {deploymentProfile.fileCount} files
                  </span>
                  <span>
                    <Folder size={13} /> {deploymentProfile.folderCount} folders
                  </span>
                  <span>
                    <Users size={13} /> Shared workspace
                  </span>
                </div>
              </section>
              <section className="deployment-section">
                <div className="deployment-section-title">
                  <Code2 size={15} />
                  <strong>Project detection</strong>
                </div>
                <div className="deployment-detail-row">
                  <span>Detected stack</span>
                  <strong>{deploymentProfile.stack}</strong>
                </div>
                <div className="deployment-detail-row">
                  <span>Build command</span>
                  <strong>{deploymentProfile.buildCommand}</strong>
                </div>
                <div className="deployment-detail-row">
                  <span>Source files</span>
                  <strong>{deploymentProfile.sourceCodeCount} non-empty</strong>
                </div>
                <div className="deployment-detail-row">
                  <span>Suggested hosting</span>
                  <strong>{deploymentProfile.recommendation}</strong>
                </div>
                {!deploymentProfile.sourceCodeCount && (
                  <div className="deployment-security-warning">
                    This workspace currently contains a project structure only.
                    Add real source code before attempting a build or
                    deployment.
                  </div>
                )}
              </section>
              <section className="deployment-section">
                <div className="deployment-section-title">
                  <Activity size={15} />
                  <strong>Build readiness checks</strong>
                </div>
                <p className="deployment-section-copy">
                  NOVA checks files and configuration it can inspect. It does
                  not execute your project's build command in this phase.
                </p>
                <div className="deployment-check-row">
                  <Check size={14} />
                  <span>Project inventory and folders</span>
                  <em>Inspected</em>
                </div>
                <div className="deployment-check-row">
                  <Activity size={14} />
                  <span>Source-code presence</span>
                  <em
                    className={
                      deploymentProfile.sourceCodeCount ? '' : 'pending'
                    }
                  >
                    {deploymentProfile.sourceCodeCount ? 'Found' : 'Missing'}
                  </em>
                </div>
                <div className="deployment-check-row">
                  <Activity size={14} />
                  <span>Build execution</span>
                  <em className="pending">Not run</em>
                </div>
                <button
                  className="primary-button"
                  onClick={runDeploymentCheck}
                  disabled={deploymentCheckBusy}
                >
                  {deploymentCheckBusy ? 'Checking…' : 'Run readiness check'}
                </button>
              </section>
              <section className="deployment-section">
                <div className="deployment-section-title">
                  <Users size={15} />
                  <strong>Shared provider connections</strong>
                </div>
                <p className="deployment-section-copy">
                  The project owner manages these shared credentials. Verify
                  them to check whether each provider accepts its token; this
                  does not publish a project.
                </p>
                <div className="deployment-provider-list">
                  {[
                    { key: 'github', label: 'GitHub' },
                    { key: 'vercel', label: 'Vercel' },
                    { key: 'netlify', label: 'Netlify' },
                    { key: 'render', label: 'Render' },
                  ].map(provider => {
                    const status = deploymentIntegrations[provider.key];
                    return (
                      <div
                        className="deployment-provider-row"
                        key={provider.key}
                      >
                        <div>
                          <strong>{provider.label}</strong>
                          <span>
                            {status ? status.message : 'Not checked yet'}
                          </span>
                        </div>
                        <em
                          className={
                            status?.connected
                              ? 'provider-connected'
                              : status?.configured
                                ? 'provider-warning'
                                : 'pending'
                          }
                        >
                          {status?.connected
                            ? 'Connected'
                            : status?.configured
                              ? 'Needs attention'
                              : 'Not checked'}
                        </em>
                      </div>
                    );
                  })}
                </div>
                {isProjectOwner ? (
                  <button
                    className="primary-button"
                    onClick={verifyDeploymentIntegrations}
                    disabled={integrationVerifyBusy}
                  >
                    {integrationVerifyBusy
                      ? 'Verifying credentials…'
                      : 'Verify all 4 connections'}
                  </button>
                ) : (
                  <div className="deployment-security-note">
                    Only the project owner can verify or manage shared provider
                    credentials.
                  </div>
                )}
              </section>
              <section className="deployment-section github-publish-section">
                <div className="deployment-section-title">
                  <Code2 size={15} />
                  <strong>GitHub repository publishing</strong>
                </div>
                <p className="deployment-section-copy">
                  Connect the repository you already created. Review and edit
                  the generated project files before publishing. The GitHub
                  token stays on NOVA's backend.
                </p>
                <label className="github-field-label">
                  GitHub repository URL
                  <input
                    className="github-field"
                    value={githubRepositoryUrl}
                    onChange={event =>
                      setGithubRepositoryUrl(event.target.value)
                    }
                    placeholder="https://github.com/owner/repository"
                    autoComplete="url"
                  />
                </label>
                <label className="github-field-label">
                  Branch{' '}
                  <span>
                    Optional · defaults to the repository's default branch
                  </span>
                  <input
                    className="github-field"
                    value={githubBranch}
                    onChange={event => setGithubBranch(event.target.value)}
                    placeholder="main"
                  />
                </label>
                <label className="github-field-label">
                  README.md <span>Edit before push</span>
                  <textarea
                    className="github-editor"
                    value={githubReadme}
                    onChange={event => setGithubReadme(event.target.value)}
                    rows={7}
                    maxLength={100000}
                  />
                </label>
                <label className="github-field-label">
                  .gitignore <span>Edit before push</span>
                  <textarea
                    className="github-editor"
                    value={githubGitignore}
                    onChange={event => setGithubGitignore(event.target.value)}
                    rows={5}
                    maxLength={30000}
                  />
                </label>
                <label className="github-field-label">
                  License
                  <select
                    className="github-field"
                    value={githubLicenseChoice}
                    onChange={event =>
                      setGithubLicenseChoice(
                        event.target.value as 'MIT' | 'None'
                      )
                    }
                  >
                    <option value="MIT">MIT License (editable)</option>
                    <option value="None">No license file</option>
                  </select>
                </label>
                {githubLicenseChoice === 'MIT' && (
                  <label className="github-field-label">
                    LICENSE <span>Edit before push</span>
                    <textarea
                      className="github-editor"
                      value={githubLicenseText}
                      onChange={event =>
                        setGithubLicenseText(event.target.value)
                      }
                      rows={7}
                      maxLength={30000}
                    />
                  </label>
                )}
                {isProjectOwner ? (
                  <button
                    className="primary-button"
                    onClick={pushProjectToGitHub}
                    disabled={
                      githubPushBusy ||
                      !files.length ||
                      !githubRepositoryUrl.trim() ||
                      !githubReadme.trim() ||
                      !githubGitignore.trim() ||
                      (githubLicenseChoice === 'MIT' &&
                        !githubLicenseText.trim())
                    }
                  >
                    {githubPushBusy
                      ? 'Publishing project…'
                      : 'Review complete · Push to GitHub'}
                  </button>
                ) : (
                  <div className="deployment-security-note">
                    Only the project owner can publish this workspace to GitHub.
                  </div>
                )}
                {githubPushResult && (
                  <div className="github-push-result">
                    <strong>Push completed</strong>
                    <a
                      href={githubPushResult.repositoryUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {githubPushResult.repositoryUrl}
                    </a>
                    <span>
                      Branch: {githubPushResult.branch} · Commit:{' '}
                      {githubPushResult.commitSha.slice(0, 7)}
                    </span>
                    <span>
                      {githubPushResult.fileCount} files published
                      {githubPushResult.skippedFiles
                        ? ' · ' +
                          githubPushResult.skippedFiles +
                          ' sensitive or unsupported files skipped'
                        : ''}
                    </span>
                  </div>
                )}
                <div className="deployment-security-note">
                  Obvious environment files, private keys, dependency folders
                  and build output are excluded. Review source code for
                  hard-coded credentials before pushing.
                </div>
              </section>
              <section className="deployment-section">
                <div className="deployment-section-title">
                  <Activity size={15} />
                  <strong>Deploy Preview to Vercel</strong>
                </div>
                <p className="deployment-section-copy">
                  Publish the current workspace as a Vercel Preview deployment.
                  NOVA uploads source files directly and keeps your Vercel token
                  on the backend. Static HTML and Vite projects are supported.
                </p>
                <div className="deployment-detail-row">
                  <span>Target</span>
                  <strong>Preview · not Production</strong>
                </div>
                <div className="deployment-detail-row">
                  <span>Detected build</span>
                  <strong>{deploymentProfile.stack}</strong>
                </div>
                {isProjectOwner ? (
                  <button
                    className="primary-button"
                    onClick={deployPreviewToVercel}
                    disabled={vercelDeployBusy || !files.length}
                  >
                    {vercelDeployBusy
                      ? 'Uploading and starting deployment…'
                      : 'Deploy Preview to Vercel'}
                  </button>
                ) : (
                  <div className="deployment-security-note">
                    Only the project owner can create Vercel deployments.
                  </div>
                )}
                {vercelDeployError && (
                  <div className="deployment-security-warning" role="alert">
                    {vercelDeployError}
                  </div>
                )}
                {vercelDeployments.length ? (
                  <div className="vercel-deployment-list">
                    {vercelDeployments.map(item => (
                      <div
                        className="vercel-deployment-item"
                        key={item.deploymentId}
                      >
                        <div className="vercel-deployment-heading">
                          <strong>{item.status.replace(/_/g, ' ')}</strong>
                          <time>
                            {new Date(item.createdAt).toLocaleString()}
                          </time>
                        </div>
                        <div className="vercel-deployment-meta">
                          {item.framework.toUpperCase()} · {item.deploymentId}
                        </div>
                        {item.url && (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            className="vercel-deployment-link"
                          >
                            Open Preview URL
                          </a>
                        )}
                        {item.errorMessage && (
                          <p className="vercel-deployment-error">
                            {item.errorMessage}
                          </p>
                        )}
                        <button
                          className="secondary-button"
                          onClick={() =>
                            refreshVercelDeployment(item.deploymentId)
                          }
                          disabled={vercelRefreshBusy !== null}
                        >
                          {vercelRefreshBusy === item.deploymentId
                            ? 'Refreshing…'
                            : 'Refresh status'}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="deployment-security-note">
                    No Vercel deployments have been created for this project
                    yet.
                  </div>
                )}
                <div className="deployment-security-note">
                  Environment-variable values and .env files are never uploaded.
                  Configure any required runtime or build variables in Vercel.
                  Deployments created here are Preview deployments only.
                </div>
              </section>
              <section className="deployment-section">
                <div className="deployment-section-title">
                  <Activity size={15} />
                  <strong>Deploy Draft to Netlify</strong>
                </div>
                <p className="deployment-section-copy">
                  Create a Netlify draft deploy without changing the site's
                  published production version. NOVA uploads publish-ready files
                  and keeps your Netlify token on the backend.
                </p>
                <div className="deployment-detail-row">
                  <span>Target</span>
                  <strong>Draft · not Production</strong>
                </div>
                <div className="deployment-detail-row">
                  <span>Supported output</span>
                  <strong>Static HTML or Vite dist/</strong>
                </div>
                {isProjectOwner ? (
                  <button
                    className="primary-button"
                    onClick={deployDraftToNetlify}
                    disabled={netlifyDeployBusy || !files.length}
                  >
                    {netlifyDeployBusy
                      ? 'Uploading and creating draft…'
                      : 'Deploy Draft to Netlify'}                  </button>
                ) : (
                  <div className="deployment-security-note">
                    Only the project owner can create Netlify deployments.
                  </div>
                )}
                {netlifyDeployError && (
                  <div className="deployment-security-warning" role="alert">
                    {netlifyDeployError}
                  </div>
                )}
                {netlifyDeployments.length ? (
                  <div className="vercel-deployment-list">
                    {netlifyDeployments.map(item => (
                      <div
                        className="vercel-deployment-item"
                        key={item.deploymentId}
                      >
                        <div className="vercel-deployment-heading">
                          <strong>{item.status.replace(/_/g, ' ')}</strong>
                          <time>
                            {new Date(item.createdAt).toLocaleString()}
                          </time>
                        </div>
                        <div className="vercel-deployment-meta">
                          {item.framework.toUpperCase()} · {item.deploymentId}
                        </div>
                        {item.url && (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            className="vercel-deployment-link"
                          >
                            Open Netlify Draft URL
                          </a>
                        )}
                        {item.errorMessage && (
                          <p className="vercel-deployment-error">
                            {item.errorMessage}
                          </p>
                        )}
                        <button
                          className="secondary-button"
                          onClick={() =>
                            refreshNetlifyDeployment(item.deploymentId)
                          }
                          disabled={netlifyRefreshBusy !== null}
                        >
                          {netlifyRefreshBusy === item.deploymentId
                            ? 'Refreshing…'
                            : 'Refresh status'}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="deployment-security-note">
                    No Netlify deployments have been created for this project
                    yet.
                  </div>
                )}
                <div className="deployment-security-note">
                  Environment-variable values and .env files are never uploaded.
                  Vite projects must have a production dist folder in the
                  workspace. Draft deployments do not replace the published
                  production version.
                </div>
              </section>
              <section className="deployment-section">
                <div className="deployment-section-title">
                  <Activity size={15} />
                  <strong>Deploy Static Site to Render</strong>
                </div>
                <p className="deployment-section-copy">
                  Connect a GitHub or GitLab repository and create a Render
                  Static Site. Render starts the first build when the service is
                  created. Later deployments are manual so new Git commits do
                  not publish automatically.
                </p>
                {renderService ? (
                  <>
                    <div className="deployment-detail-row">
                      <span>Render service</span>
                      <strong>{renderService.serviceName}</strong>
                    </div>
                    <div className="deployment-detail-row">
                      <span>Workspace</span>
                      <strong>{renderService.ownerName}</strong>
                    </div>
                    <div className="deployment-detail-row">
                      <span>Repository</span>
                      <strong>{renderService.repo}</strong>
                    </div>
                    <div className="deployment-detail-row">
                      <span>Branch · publish directory</span>
                      <strong>
                        {renderService.branch} · {renderService.publishPath}
                      </strong>
                    </div>
                    <div className="deployment-detail-row">
                      <span>Automatic deploys</span>
                      <strong>Off · manual only</strong>
                    </div>
                    {renderService.url && (
                      <a
                        href={renderService.url}
                        target="_blank"
                        rel="noreferrer"
                        className="vercel-deployment-link"
                      >
                        Open live Render site
                      </a>
                    )}
                    {renderService.dashboardUrl && (
                      <a
                        href={renderService.dashboardUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="vercel-deployment-link"
                      >
                        Open Render dashboard
                      </a>
                    )}
                    {isProjectOwner && (
                      <button
                        className="primary-button"
                        onClick={triggerRenderDeploy}
                        disabled={renderDeployBusy}
                      >
                        {renderDeployBusy
                          ? 'Queueing deployment…'
                          : 'Manual deploy latest commit'}
                      </button>
                    )}
                    <button
                      className="secondary-button"
                      onClick={loadRenderService}
                      disabled={renderRefreshBusy}
                    >
                      {renderRefreshBusy
                        ? 'Refreshing…'
                        : 'Refresh Render status'}
                    </button>
                    {renderDeployments.length ? (
                      <div className="vercel-deployment-list">
                        {renderDeployments.map(item => (
                          <div
                            className="vercel-deployment-item"
                            key={item.deploymentId}
                          >
                            <div className="vercel-deployment-heading">
                              <strong>{item.status.replace(/_/g, ' ')}</strong>
                              <time>
                                {new Date(item.createdAt).toLocaleString()}
                              </time>
                            </div>
                            <div className="vercel-deployment-meta">
                              {item.trigger || 'Render'} · {item.deploymentId}
                            </div>
                            {item.commitMessage && (
                              <p className="deployment-section-copy">
                                {item.commitMessage}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="deployment-security-note">
                        No Render deployment history is available yet. Refresh
                        after the first build starts.
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="deployment-detail-row">
                      <span>Service type</span>
                      <strong>
                        Static Site · first deploy starts on creation
                      </strong>
                    </div>
                    <label className="github-field-label">
                      Render workspace
                      <select
                        className="github-field"
                        value={selectedRenderOwnerId}
                        onChange={event =>
                          setSelectedRenderOwnerId(event.target.value)
                        }
                        disabled={
                          renderWorkspaceBusy || !renderWorkspaces.length
                        }
                      >
                        <option value="">Select a Render workspace</option>
                        {renderWorkspaces.map(workspace => (
                          <option key={workspace.id} value={workspace.id}>
                            {workspace.name}
                            {workspace.type ? ' · ' + workspace.type : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="secondary-button"
                      onClick={loadRenderAvailableServices}
                      disabled={
                        renderAvailableBusy ||
                        renderWorkspaceBusy ||
                        !selectedRenderOwnerId
                      }
                    >
                      {renderAvailableBusy
                        ? 'Searching Render services…'
                        : 'Find existing Render services'}
                    </button>
                    {renderAvailableServices.length > 0 && (
                      <>
                        <label className="github-field-label">
                          Existing Render Static Site
                          <select
                            className="github-field"
                            value={renderSelectedExistingServiceId}
                            onChange={event =>
                              setRenderSelectedExistingServiceId(
                                event.target.value
                              )
                            }
                            disabled={renderConnectBusy}
                          >
                            {renderAvailableServices.map(service => (
                              <option
                                key={service.serviceId}
                                value={service.serviceId}
                              >
                                {service.serviceName} ·{' '}
                                {service.repo || 'Repository not reported'} ·{' '}
                                {service.branch || 'default branch'}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="primary-button"
                          onClick={connectExistingRenderService}
                          disabled={
                            renderConnectBusy ||
                            !renderSelectedExistingServiceId
                          }
                        >
                          {renderConnectBusy
                            ? 'Connecting existing service…'
                            : 'Connect selected existing service'}
                        </button>
                      </>
                    )}
                    <div className="deployment-security-note">
                      Connecting an existing service only links it to this NOVA
                      project. It does not create, delete, redeploy, or change
                      the Render service.
                    </div>
                    <label className="github-field-label">
                      Git repository URL
                      <input
                        className="github-field"
                        value={renderRepo}
                        onChange={event => setRenderRepo(event.target.value)}
                        placeholder="https://github.com/owner/repository"
                        autoComplete="url"
                      />
                    </label>
                    <label className="github-field-label">
                      Branch
                      <input
                        className="github-field"
                        value={renderBranch}
                        onChange={event => setRenderBranch(event.target.value)}
                        placeholder="main"
                      />
                    </label>
                    <label className="github-field-label">
                      Build command
                      <input
                        className="github-field"
                        value={renderBuildCommand}
                        onChange={event =>
                          setRenderBuildCommand(event.target.value)
                        }
                        placeholder="npm ci && npm run build"
                      />
                    </label>
                    <label className="github-field-label">
                      Publish directory
                      <input
                        className="github-field"
                        value={renderPublishPath}
                        onChange={event =>
                          setRenderPublishPath(event.target.value)
                        }
                        placeholder="dist"
                      />
                    </label>
                    <div className="deployment-security-note">
                      Vite: use <code>npm ci && npm run build</code> and{' '}
                      <code>dist</code>. Static HTML: use{' '}
                      <code>echo 'Static site ready'</code> and <code>.</code>.
                      Make sure the repository is connected to Render's Git
                      provider.
                    </div>
                    {isProjectOwner ? (
                      <button
                        className="primary-button"
                        onClick={createRenderService}
                        disabled={
                          renderCreateBusy ||
                          renderWorkspaceBusy ||
                          !selectedRenderOwnerId ||
                          !renderRepo.trim()
                        }
                      >
                        {renderCreateBusy
                          ? 'Creating Render service…'
                          : 'Create Render Static Site'}
                      </button>
                    ) : (
                      <div className="deployment-security-note">
                        Only the project owner can create Render services.
                      </div>
                    )}
                  </>
                )}
                {renderError && (
                  <div className="deployment-security-warning" role="alert">
                    {renderError}
                  </div>
                )}
                <div className="deployment-security-note">
                  Render builds from the connected Git repository. NOVA stores
                  only the service reference; the Render API key stays on the
                  backend. Auto-deploys are disabled. Creating a service starts
                  its initial deployment; manual deploys are available
                  afterward.
                </div>
              </section>
              <section className="deployment-section">
                <div className="deployment-section-title">
                  <Settings2 size={15} />
                  <strong>Environment variables</strong>
                </div>
                <p className="deployment-section-copy">
                  Detected variable names only. NOVA never asks you to paste
                  secret values here.
                </p>
                {deploymentProfile.envVarNames.length ? (
                  <>
                    <div className="deployment-env-list">
                      {deploymentProfile.envVarNames.map(name => (
                        <div key={name}>
                          <code>{name}</code>
                          <span>Needs provider configuration</span>
                        </div>
                      ))}
                    </div>
                    <button
                      className="secondary-button"
                      onClick={downloadEnvTemplate}
                    >
                      Download .env.example template
                    </button>
                  </>
                ) : (
                  <div className="deployment-security-note">
                    No environment-variable references found in the current
                    source files.
                  </div>
                )}
              </section>
              <section className="deployment-section">
                <div className="deployment-section-title">
                  <CheckCircle2 size={15} />
                  <strong>Pre-deployment review</strong>
                </div>
                <div className="deployment-check-row">
                  <Check size={14} />
                  <span>Shared project files included</span>
                  <em>Ready</em>
                </div>
                <div className="deployment-check-row">
                  <Check size={14} />
                  <span>Folder structure preserved</span>
                  <em>Ready</em>
                </div>
                <div className="deployment-check-row">
                  <Activity size={14} />
                  <span>Build and runtime validation</span>
                  <em className="pending">Not run</em>
                </div>
                <div className="deployment-check-row">
                  <Activity size={14} />
                  <span>Hosting provider connection</span>
                  <em className="pending">Phase 3</em>
                </div>
                {deploymentProfile.secretFiles.length > 0 ? (
                  <div className="deployment-security-warning">
                    {deploymentProfile.secretFiles.length} likely secret file(s)
                    will be excluded from the ZIP:{' '}
                    {deploymentProfile.secretFiles.slice(0, 4).join(', ')}
                    {deploymentProfile.secretFiles.length > 4 ? '…' : ''}
                  </div>
                ) : (
                  <div className="deployment-security-note">
                    Obvious .env and private-key files are excluded during
                    export. Review source code for hard-coded secrets too.
                  </div>
                )}
              </section>
              <section className="deployment-export-card">
                <div>
                  <Download size={17} />
                  <strong>Manual deployment package</strong>
                </div>
                <p>
                  Download the latest shared workspace files as a ZIP, with a
                  NOVA deployment guide. Obvious secret files are skipped and
                  listed in the guide.
                </p>
                <button
                  className="primary-button"
                  onClick={exportProjectZip}
                  disabled={!files.length}
                >
                  <Download size={14} /> Download project ZIP
                </button>
              </section>
              <section className="deployment-section">
                <div className="deployment-section-title">
                  <Activity size={15} />
                  <strong>Deployment activity</strong>
                </div>
                {deploymentActivity.length ? (
                  deploymentActivity.map(item => (
                    <div className="deployment-history-item" key={item.id}>
                      <div>
                        <strong>{item.status.replace(/_/g, ' ')}</strong>
                        <time>{new Date(item.createdAt).toLocaleString()}</time>
                      </div>
                      <p>{item.summary}</p>
                    </div>
                  ))
                ) : (
                  <div className="deployment-security-note">
                    No deployment checks have been recorded for this project
                    yet.
                  </div>
                )}
              </section>
              <div className="deployment-phase-note">
                <Sparkles size={14} /> Phase 4.1 · Vercel Preview deployment is
                available for static HTML and Vite workspaces. Deployments are
                tracked separately from preflight checks; production releases
                and rollback are not enabled yet.
              </div>
              <section className="deployment-section deployment-reset-section">
                <div className="deployment-section-title">
                  <Settings2 size={15} />
                  <strong>Reset deployment connection</strong>
                </div>
                <p className="deployment-section-copy">
                  Reset only removes the saved Render service link from this
                  NOVA project so you can configure it again. It does not delete
                  the Render service, deployments, live website, or any provider
                  credentials.
                </p>
                {isProjectOwner ? (
                  <button
                    className="secondary-button"
                    onClick={resetRenderConnection}
                    disabled={
                      !renderService ||
                      renderResetBusy ||
                      renderDeployBusy ||
                      renderRefreshBusy
                    }
                  >
                    {renderResetBusy
                      ? 'Resetting Render connection…'
                      : 'Reset Render connection'}
                  </button>
                ) : (
                  <div className="deployment-security-note">
                    Only the project owner can reset the saved Render
                    connection.
                  </div>
                )}
              </section>
            </aside>
          </>
        )}
        {showMembers && (
          <>
            <button
              className="panel-scrim"
              onClick={() => setShowMembers(false)}
              aria-label="Close members panel"
            />
            <aside className="members-panel">
              <div className="members-panel-head">
                <div>
                  <span className="eyebrow">TEAM</span>
                  <h3>Workspace members</h3>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setShowMembers(false)}
                >
                  <X size={17} />
                </button>
              </div>
              <p className="members-caption">
                Invite up to two teammates to code together.
              </p>
              <div className="invite-box">
                <span>PROJECT INVITE CODE</span>
                <div>
                  <strong>{activeProject.inviteCode}</strong>
                  <button onClick={copyInvite}>
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <section className="team-profile-card">
                <div className="team-section-title">
                  <Target size={15} />
                  <strong>Your skill profile</strong>
                  <span>Used for dynamic role matching</span>
                </div>
                <label>
                  Skills <small>Comma-separated</small>
                </label>
                <input
                  value={teamSkillsText}
                  onChange={event => setTeamSkillsText(event.target.value)}
                  placeholder="React, Python, UI design, SQL…"
                />
                <label>
                  Preferred work <small>Optional</small>
                </label>
                <input
                  value={teamInterestsText}
                  onChange={event => setTeamInterestsText(event.target.value)}
                  placeholder="Frontend, integrations, testing…"
                />
                <label>Experience level</label>
                <select
                  value={teamProfile.experience}
                  onChange={event =>
                    setTeamProfile(current => ({
                      ...current,
                      experience: event.target.value,
                    }))
                  }
                >
                  <option value="beginner">Beginner</option>
                  <option value="intermediate">Intermediate</option>
                  <option value="advanced">Advanced</option>
                </select>
                <button
                  className="secondary-button team-save"
                  disabled={teamBusy || !teamSkillsText.trim()}
                  onClick={saveTeamProfile}
                >
                  <Check size={14} />{' '}
                  {teamBusy ? 'Saving…' : 'Save skill profile'}
                </button>
              </section>
              <div className="team-plan-heading">
                <div>
                  <Sparkles size={15} />
                  <strong>Dynamic team plan</strong>
                </div>
                {isProjectOwner && !allRolesAccepted && (
                  <button
                    className="primary-button"
                    disabled={teamBusy || members.length < 2}
                    onClick={generateTeamPlan}
                  >
                    <Sparkles size={14} />{' '}
                    {teamBusy ? 'Working…' : 'Assign roles'}
                  </button>
                )}
              </div>
              {isProjectOwner && allRolesAccepted && (
                <button
                  className="primary-button continue-project-button"
                  onClick={() => setShowSetupModal(true)}
                >
                  <ChevronRight size={15} /> Continue Project
                </button>
              )}
              {teamNotice && <p className="team-notice">{teamNotice}</p>}
              {teamAssignments.length > 0 ? (
                <div className="team-assignment-list">
                  {teamAssignments.map(assignment => (
                    <article className="team-assignment" key={assignment.id}>
                      <div className="team-assignment-top">
                        <div>
                          <span>{assignment.title}</span>
                          <strong>{assignment.role}</strong>
                          <small>{assignment.memberName}</small>
                        </div>
                        <em
                          className={'assignment-status ' + assignment.status}
                        >
                          {assignment.status.replace('_', ' ')}
                        </em>
                      </div>
                      <p>{assignment.rationale}</p>
                      <ul>
                        {assignment.tasks.map(task => (
                          <li key={task}>{task}</li>
                        ))}
                      </ul>
                      {assignment.userId === user?.userId &&
                        assignment.status === 'proposed' && (
                          <div className="team-response-actions">
                            <button
                              className="secondary-button"
                              disabled={teamBusy}
                              onClick={() =>
                                respondToAssignment(
                                  assignment,
                                  'request-change'
                                )
                              }
                            >
                              Request change
                            </button>
                            <button
                              className="primary-button"
                              disabled={teamBusy}
                              onClick={() =>
                                respondToAssignment(assignment, 'accept')
                              }
                            >
                              <CheckCircle2 size={14} /> Accept role
                            </button>
                          </div>
                        )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="team-empty">
                  Save each teammate’s skills, then the project owner can
                  generate a balanced plan.
                </div>
              )}
              <div className="member-list">
                {members.map(member => (
                  <div className="member-item" key={member.userId}>
                    <div className="avatar">
                      {member.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <strong>{member.name}</strong>
                      <span>
                        {member.userId === activeProject?.ownerId
                          ? 'Project owner'
                          : 'Teammate'}
                      </span>
                    </div>
                    <span className="member-online">
                      <i /> Joined
                    </span>
                  </div>
                ))}
              </div>
              <div className="member-limit">
                <Users size={15} /> {members.length} of 3 seats used
              </div>
              {showSetupModal && (
                <div className="setup-modal-backdrop">
                  <section
                    className="setup-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="setup-modal-title"
                  >
                    <div className="setup-modal-heading">
                      <div>
                        <span className="eyebrow">TEAM READY</span>
                        <h3 id="setup-modal-title">Continue your project</h3>
                      </div>
                      <button
                        className="icon-button"
                        onClick={() => setShowSetupModal(false)}
                        aria-label="Close setup choices"
                      >
                        <X size={17} />
                      </button>
                    </div>
                    <p>
                      All three teammates accepted their roles. Choose how you
                      want to prepare the shared project. Nothing starts until
                      you choose.
                    </p>
                    <div className="setup-choice-grid">
                      <button
                        className={
                          'setup-choice ' +
                          (setupMode === 'ai' ? 'selected' : '')
                        }
                        onClick={() => setSetupMode('ai')}
                      >
                        <Sparkles size={18} />
                        <strong>AI creates structure</strong>
                        <span>
                          Describe the project and NOVA builds the initial
                          folders and files.
                        </span>
                      </button>
                      <button
                        className={
                          'setup-choice ' +
                          (setupMode === 'prompt' ? 'selected' : '')
                        }
                        onClick={() => setSetupMode('prompt')}
                      >
                        <Bot size={18} />
                        <strong>Use my AI prompt</strong>
                        <span>
                          Paste a structure prompt from ChatGPT, Gemini or
                          another AI.
                        </span>
                      </button>
                      <button
                        className="setup-choice"
                        onClick={() => startManualImport('zip')}
                      >
                        <Upload size={18} />
                        <strong>Import existing project</strong>
                        <span>
                          Choose a ZIP archive to add existing source files.
                        </span>
                      </button>
                    </div>
                    {(setupMode === 'ai' || setupMode === 'prompt') && (
                      <div className="setup-prompt-area">
                        <label>
                          {setupMode === 'ai'
                            ? 'What are you building?'
                            : 'Paste your structure prompt'}
                        </label>
                        <textarea
                          value={setupPrompt}
                          onChange={event => setSetupPrompt(event.target.value)}
                          maxLength={6000}
                          rows={5}
                          placeholder={
                            setupMode === 'ai'
                              ? 'Example: A modern booking platform with customer accounts, search, and an admin dashboard…'
                              : 'Paste the complete project structure prompt here…'
                          }
                        />
                        <span>{setupPrompt.length}/6000 characters</span>
                      </div>
                    )}
                    <div className="setup-modal-actions">
                      <button
                        className="quiet-button"
                        onClick={() => startManualImport('folder')}
                      >
                        Import folder instead
                      </button>
                      <button
                        className="primary-button"
                        disabled={setupBusy || !setupPrompt.trim()}
                        onClick={submitSetupChoice}
                      >
                        {setupBusy
                          ? 'Preparing…'
                          : setupMode === 'ai'
                            ? 'Generate structure'
                            : 'Apply prompt'}
                      </button>
                    </div>
                  </section>
                </div>
              )}
            </aside>
          </>
        )}
      </div>
      {(quickOpenOpen || commandPaletteOpen) && (
        <div
          className="nova-dialog-backdrop nova-palette-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget) {
              setQuickOpenOpen(false);
              setCommandPaletteOpen(false);
              setPaletteQuery('');
            }
          }}
        >
          <section
            className="nova-palette"
            role="dialog"
            aria-modal="true"
            aria-label={quickOpenOpen ? 'Quick open file' : 'Command palette'}
          >
            <input
              autoFocus
              className="nova-palette-input"
              aria-label={quickOpenOpen ? 'Search project files' : 'Search commands'}
              placeholder={quickOpenOpen ? 'Search files by name…' : 'Type a command…'}
              value={paletteQuery}
              onChange={event => {
                setPaletteQuery(event.target.value);
                setPaletteActiveIndex(0);
              }}
              onKeyDown={event => {
                const count = quickOpenOpen
                  ? quickOpenFiles.length
                  : filteredPaletteCommands.length;
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setQuickOpenOpen(false);
                  setCommandPaletteOpen(false);
                  setPaletteQuery('');
                } else if (event.key === 'ArrowDown' && count) {
                  event.preventDefault();
                  setPaletteActiveIndex(index => (index + 1) % count);
                } else if (event.key === 'ArrowUp' && count) {
                  event.preventDefault();
                  setPaletteActiveIndex(index => (index - 1 + count) % count);
                } else if (event.key === 'Enter' && count) {
                  event.preventDefault();
                  if (quickOpenOpen) {
                    const file = quickOpenFiles[paletteActiveIndex] || quickOpenFiles[0];
                    if (file) openFile(file);
                    setQuickOpenOpen(false);
                  } else {
                    const command = filteredPaletteCommands[paletteActiveIndex] || filteredPaletteCommands[0];
                    if (command) runPaletteCommand(command.id);
                  }
                  setPaletteQuery('');
                }
              }}
            />
            <div className="nova-palette-results">
              {quickOpenOpen && activeProject ? (
                quickOpenFiles.map((file, index) => (
                  <button
                    key={file.id}
                    type="button"
                    className="nova-palette-item"
                    aria-selected={paletteActiveIndex === index}
                    onMouseEnter={() => setPaletteActiveIndex(index)}
                    onClick={() => {
                      openFile(file);
                      setQuickOpenOpen(false);
                      setPaletteQuery('');
                    }}
                  >
                    <FileCode2 size={15} />
                    <span>{file.name}</span>
                    <small>{file.parentId ? 'Nested file' : 'Root file'}</small>
                  </button>
                ))
              ) : (
                filteredPaletteCommands.map((command, index) => (
                  <button
                    key={command.id}
                    type="button"
                    className="nova-palette-item"
                    aria-selected={paletteActiveIndex === index}
                    onMouseEnter={() => setPaletteActiveIndex(index)}
                    onClick={() => runPaletteCommand(command.id)}
                  >
                    <Command size={15} />
                    <span>{command.label}</span>
                    <small>{command.shortcut}</small>
                  </button>
                ))
              )}
              {quickOpenOpen && !activeProject && (
                <div className="nova-palette-empty">
                  Open a project first to search its files.
                </div>
              )}
              {quickOpenOpen && activeProject && !quickOpenFiles.length && (
                <div className="nova-palette-empty">No matching files</div>
              )}
              {!quickOpenOpen && !filteredPaletteCommands.length && (
                <div className="nova-palette-empty">No matching commands</div>
              )}
            </div>
            <div className="nova-palette-footer">
              ↑ ↓ Navigate · Enter Select · Esc Close
            </div>
          </section>
        </div>
      )}
      {confirmDialog && (
        <div
          className="nova-dialog-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget) closeConfirmation(false);
          }}
        >
          <section
            className="nova-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="nova-confirm-title"
          >
            <div className="nova-confirm-icon">
              <AlertTriangle size={30} strokeWidth={2.2} />
            </div>
            <h2 id="nova-confirm-title">{confirmDialog.title}</h2>
            <p>{confirmDialog.message}</p>
            <div className="nova-confirm-actions">
              <button
                className="secondary-button"
                onClick={() => closeConfirmation(false)}
              >
                Cancel
              </button>
              <button
                className="nova-warning-button"
                onClick={() => closeConfirmation(true)}
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
