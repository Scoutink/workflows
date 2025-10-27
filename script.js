document.addEventListener('DOMContentLoaded', () => {
    // --- DOM ---
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const workflowRoot = document.getElementById('workflow-root');
    const modeSwitch = document.getElementById('mode-switch-checkbox');

    const saveStructureBtn = document.getElementById('save-structure-btn');
    const saveExecutionBtn = document.getElementById('save-execution-btn');

    const enforceSequenceCheckbox = document.getElementById('enforce-sequence-checkbox');

    const flowSelect = document.getElementById('flow-select');
    const flowNewBtn = document.getElementById('flow-new');
    const flowRenameBtn = document.getElementById('flow-rename');
    const flowDeleteBtn = document.getElementById('flow-delete');
    const globalTagFilterBtn = document.getElementById('global-tag-filter');

    const modal = {
        backdrop: document.getElementById('modal-backdrop'),
        title: document.getElementById('modal-title'),
        body: document.getElementById('modal-body'),
        closeBtn: document.getElementById('modal-close-btn')
    };

    // --- APP STATE ---
    let appState = {
        theme: 'light',
        currentMode: 'execution',
        // Structure (creation) data with multi-flows
        workflow: {
            settings: { enforceSequence: true },
            flows: [] // [{id,name,data:[controls...]}]
        },
        // Execution persistence separated by flow & evidence id
        executions: {
            flows: {
                // flowId: { completed: { evidenceId: true/false } }
            }
        },
        // current flow selection
        currentFlowId: null,
        // selection & UI
        selectedActionPaths: {},
        expandedTextAreas: new Set(),
        activeTag: null // per-flow execution tag filter
    };

    let quillEditor = null;

    // --- UTILITIES ---
    const generateId = (prefix) =>
        `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const getAbsoluteUrl = (url) => {
        if (typeof url !== 'string' || url.trim() === '') return 'about:blank';
        if (url.startsWith('assets/')) return url;
        if (url.startsWith('http://') || url.startsWith('https://')) return url;
        return `https://${url}`;
    };

    const ensureTagsArray = (node) => { if (!node.tags) node.tags = []; return node.tags; };
    const nodeHasTag = (node, tag) => (node.tags || []).includes(tag);

    // --- THEME / MODE ---
    const applyTheme = (theme) => {
        document.body.classList.toggle('dark-theme', theme === 'dark');
        appState.theme = theme;
        localStorage.setItem('workflowTheme', theme);
        render();
    };
    const toggleTheme = () => applyTheme(appState.theme === 'light' ? 'dark' : 'light');

    // --- FLOW HELPERS ---
    const getCurrentFlow = () => appState.workflow.flows.find(f => f.id === appState.currentFlowId) || null;

    const getObjectByPath = (path, flow) => {
        const root = { data: flow.data };
        return path.split('.').reduce((acc, key) => acc && acc[key], root);
    };
    const getParentAndKey = (path, flow) => {
        const parts = path.split('.');
        const key = parseInt(parts.pop(), 10);
        return { parent: getObjectByPath(parts.join('.'), flow), key };
    };

    // --- EXECUTION STATE ---
    const ensureExecFlow = (flowId) => {
        if (!appState.executions.flows[flowId]) {
            appState.executions.flows[flowId] = { completed: {} };
        }
        return appState.executions.flows[flowId];
    };
    const setCompleted = (flowId, evidenceId, value) => {
        const exec = ensureExecFlow(flowId);
        exec.completed[evidenceId] = !!value;
    };
    const getCompleted = (flowId, evidenceId, fallback) => {
        const exec = ensureExecFlow(flowId);
        const v = exec.completed[evidenceId];
        return (typeof v === 'boolean') ? v : !!fallback;
    };

    // Build a map: shareKey => [{flowId, evidenceId}]
    const sharedEvidenceIndex = () => {
        const map = new Map();
        appState.workflow.flows.forEach(flow => {
            (flow.data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => (act.subcategories || []).forEach(ev => {
                if (ev.shareKey) {
                    const arr = map.get(ev.shareKey) || [];
                    arr.push({ flowId: flow.id, evidenceId: ev.id });
                    map.set(ev.shareKey, arr);
                }
            })));
        });
        return map;
    };

    // Propagate an execution change across all flows that share the same shareKey
    const propagateSharedExecution = (shareKey, value) => {
        if (!shareKey) return;
        const idx = sharedEvidenceIndex();
        const entries = idx.get(shareKey) || [];
        entries.forEach(({ flowId, evidenceId }) => {
            setCompleted(flowId, evidenceId, value);
        });
    };

    // Reconcile execution map after structure changes across ALL flows
    const reconcileAllExecutions = () => {
        const existingEvidenceIds = new Set();
        appState.workflow.flows.forEach(flow => {
            (flow.data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => (act.subcategories || []).forEach(ev => {
                existingEvidenceIds.add(ev.id);
            })));
        });
        Object.keys(appState.executions.flows).forEach(fid => {
            const comp = appState.executions.flows[fid]?.completed || {};
            Object.keys(comp).forEach(eid => {
                if (!existingEvidenceIds.has(eid)) delete comp[eid];
            });
        });
    };

    // When a flow is created via "share", initialize its execution from source flow
    const initializeSharedExecutionFromSource = (newFlowId, srcFlowId) => {
        const newFlow = appState.workflow.flows.find(f => f.id === newFlowId);
        const srcExec = ensureExecFlow(srcFlowId);
        (newFlow.data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => (act.subcategories || []).forEach(ev => {
            if (ev.shareKey) {
                // find any evidence with same shareKey in src flow
                const srcFlow = appState.workflow.flows.find(f => f.id === srcFlowId);
                let srcEv = null;
                (srcFlow.data || []).forEach(c => (c.subcategories || []).forEach(a => (a.subcategories || []).forEach(evv => {
                    if (evv.shareKey === ev.shareKey) srcEv = evv;
                })));
                if (srcEv && typeof srcExec.completed[srcEv.id] === 'boolean') {
                    setCompleted(newFlowId, ev.id, srcExec.completed[srcEv.id]);
                }
            }
        })));
    };

    // reconcile execution when a specific flow structure changes (helper)
    const reconcileExecution = (flowId) => {
        const flow = appState.workflow.flows.find(f => f.id === flowId);
        const exec = ensureExecFlow(flowId);
        const existingIds = new Set();
        (flow.data || []).forEach(c => (c.subcategories || []).forEach(a => (a.subcategories || []).forEach(e => existingIds.add(e.id))));
        for (const id of Object.keys(exec.completed)) {
            if (!existingIds.has(id)) delete exec.completed[id];
        }
    };

    // --- SHARING (STRUCTURE) ---
    const setShareKeyDeep = (node, shareKey) => {
        node.shareKey = shareKey;
        (node.subcategories || []).forEach(ch => setShareKeyDeep(ch, shareKey));
    };
    const propagateSharedEdit = (editedNode, level /* 'control'|'action'|'evidence' */) => {
        if (!editedNode.shareKey) return;
        appState.workflow.flows.forEach(flow => {
            (flow.data || []).forEach(ctl => {
                if (level === 'control' && ctl.shareKey === editedNode.shareKey) {
                    Object.assign(ctl, { name: editedNode.name, text: editedNode.text, tags: editedNode.tags });
                }
                (ctl.subcategories || []).forEach((act) => {
                    if (level !== 'control' && act.shareKey === editedNode.shareKey) {
                        Object.assign(act, { name: editedNode.name, text: editedNode.text, tags: editedNode.tags });
                    }
                    (act.subcategories || []).forEach((ev) => {
                        if (level === 'evidence' && ev.shareKey === editedNode.shareKey) {
                            Object.assign(ev, { name: editedNode.name, text: editedNode.text, tags: editedNode.tags, grade: editedNode.grade });
                        }
                    });
                });
            });
        });
    };
    const propagateSharedDelete = (shareKey, level) => {
        appState.workflow.flows.forEach(flow => {
            if (level === 'control') {
                flow.data = (flow.data || []).filter(n => n.shareKey !== shareKey);
            } else if (level === 'action') {
                (flow.data || []).forEach(ctl => {
                    ctl.subcategories = (ctl.subcategories || []).filter(a => a.shareKey !== shareKey);
                });
            } else if (level === 'evidence') {
                (flow.data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => {
                    act.subcategories = (act.subcategories || []).filter(e => e.shareKey !== shareKey);
                }));
            }
        });
        reconcileAllExecutions();
    };

    // --- SERVER IO ---
    async function loadAll() {
        try {
            const [wfRes, exRes] = await Promise.all([
                fetch(`workflow.json?t=${Date.now()}`),
                fetch(`executions.json?t=${Date.now()}`)
            ]);
            if (!wfRes.ok) throw new Error('Failed to load workflow.json');
            appState.workflow = await wfRes.json();

            // MIGRATION: legacy shape -> multi-flow
            if (!Array.isArray(appState.workflow.flows)) {
                const legacy = appState.workflow;
                appState.workflow = {
                    settings: legacy.settings || { enforceSequence: true },
                    flows: [{
                        id: generateId('flow'),
                        name: 'Default Flow',
                        data: legacy.data || []
                    }]
                };
            }

            if (exRes.ok) {
                appState.executions = await exRes.json();
                if (!appState.executions || !appState.executions.flows) appState.executions = { flows: {} };
            } else {
                appState.executions = { flows: {} };
            }

            if (!appState.currentFlowId || !getCurrentFlow()) {
                appState.currentFlowId = appState.workflow.flows[0]?.id || null;
            }

            initializeState();
        } catch (e) {
            console.error(e);
            workflowRoot.innerHTML = `<div class="empty-state">Could not load data. Ensure <code>workflow.json</code> exists.</div>`;
        }
    }

    async function saveStructure() {
        const btn = saveStructureBtn;
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
        try {
            const res = await fetch('save_workflow.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(appState.workflow)
            });
            const json = await res.json();
            if (!res.ok || json.status !== 'success') throw new Error(json.message || 'Save failed');
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved!';
            setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1200);
        } catch (e) {
            console.error(e);
            btn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Save Failed';
            setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1600);
        }
    }
    async function saveExecution() {
        const btn = saveExecutionBtn;
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;
        try {
            const res = await fetch('save_executions.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(appState.executions)
            });
            const json = await res.json();
            if (!res.ok || json.status !== 'success') throw new Error(json.message || 'Save failed');
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved!';
            setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1200);
        } catch (e) {
            console.error(e);
            btn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Save Failed';
            setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1600);
        }
    }

    // --- MODAL ---
    const openModal = (title, body, onOpen = () => {}) => {
        modal.title.innerHTML = title;
        modal.body.innerHTML = body;
        modal.backdrop.classList.remove('hidden');
        document.body.classList.add('modal-open');
        onOpen();
    };
    const closeModal = () => {
        modal.backdrop.classList.add('hidden');
        modal.body.innerHTML = '';
        document.body.classList.remove('modal-open');
        quillEditor = null;
    };

    // --- TAGS UI ---
    const renderTags = (node, path, flow) => {
        ensureTagsArray(node);
        const chips = node.tags.map((t, i) => {
            const actionName = appState.currentMode === 'execution' ? 'filter-by-tag' : 'edit-tag';
            const suffix = appState.currentMode === 'creation'
                ? ` <button class="tag-delete" data-action="delete-tag" data-path="${path}" data-index="${i}" title="Remove tag">&times;</button>`
                : '';
            return `<span class="tag-item" data-action="${actionName}" data-path="${path}" data-index="${i}" data-tag="${t}">#${t}${suffix}</span>`;
        }).join('');
        const addInput = appState.currentMode === 'creation'
            ? `<input class="add-tag-input" data-path="${path}" placeholder="Add tag and press Enter">`
            : '';
        return `<div class="evidence-tags">${chips}${addInput}</div>`;
    };

    // --- FILTERING (per-flow, with downward inheritance and original path preservation) ---
    function copyActionWithAllEvidencePaths(action, actPath) {
        return {
            ...action,
            _path: actPath,
            subcategories: (action.subcategories || []).map((ev, ei) => ({
                ...ev,
                _path: `${actPath}.subcategories.${ei}`
            }))
        };
    }
    function filterWorkflowByTag(data, tag, basePath = 'data') {
        const filteredControls = [];
        (data || []).forEach((ctl, ci) => {
            const ctlPath = `${basePath}.${ci}`;

            if (nodeHasTag(ctl, tag)) {
                const fullActions = (ctl.subcategories || []).map((act, ai) =>
                    copyActionWithAllEvidencePaths(act, `${ctlPath}.subcategories.${ai}`));
                filteredControls.push({ ...ctl, _path: ctlPath, subcategories: fullActions });
                return;
            }
            const keptActions = [];
            (ctl.subcategories || []).forEach((act, ai) => {
                const actPath = `${ctlPath}.subcategories.${ai}`;
                if (nodeHasTag(act, tag)) {
                    keptActions.push(copyActionWithAllEvidencePaths(act, actPath));
                    return;
                }
                const keptEvidence = [];
                (act.subcategories || []).forEach((ev, ei) => {
                    const evPath = `${actPath}.subcategories.${ei}`;
                    if (nodeHasTag(ev, tag)) keptEvidence.push({ ...ev, _path: evPath });
                });
                if (keptEvidence.length > 0) {
                    keptActions.push({ ...act, _path: actPath, subcategories: keptEvidence });
                }
            });
            if (keptActions.length > 0) filteredControls.push({ ...ctl, _path: ctlPath, subcategories: keptActions });
        });
        return filteredControls;
    }

    // --- RENDERING ---
    const render = () => {
        document.body.className = `${appState.currentMode}-mode ${appState.theme}-theme`;

        // flow select
        flowSelect.innerHTML = appState.workflow.flows.map(f =>
            `<option value="${f.id}" ${f.id === appState.currentFlowId ? 'selected' : ''}>${f.name}</option>`
        ).join('');
        const currentFlow = getCurrentFlow();
        if (!currentFlow) {
            workflowRoot.innerHTML = `<div class="empty-state">No flows. Create one to get started.</div>`;
            return;
        }

        // top toggles
        modeSwitch.checked = appState.currentMode === 'execution';
        enforceSequenceCheckbox.checked = appState.workflow.settings.enforceSequence;

        // tag banner
        const banner = document.getElementById('tag-filter-banner');
        const label = document.getElementById('active-tag-label');
        if (appState.activeTag) {
            label.textContent = `#${appState.activeTag}`;
            banner.classList.remove('hidden');
        } else {
            banner.classList.add('hidden');
        }

        // data (filtered or raw)
        const rawData = currentFlow.data || [];
        const filteredData = appState.activeTag ? filterWorkflowByTag(rawData, appState.activeTag) : null;
        const dataToRender = filteredData || rawData;

        workflowRoot.innerHTML = '';
        if (dataToRender.length === 0) {
            workflowRoot.innerHTML = `<div class="empty-state">${appState.activeTag ? 'No items match this tag.' : 'This flow is empty. Add a rule.'}</div>`;
            return;
        }

        const frag = document.createDocumentFragment();
        dataToRender.forEach((control, index) => {
            const pathForControl = filteredData ? control._path : `data.${index}`;
            frag.appendChild(renderControlNode(control, pathForControl, !!filteredData, currentFlow));
        });
        workflowRoot.appendChild(frag);
    };

    const calculateActionProgress = (action) => {
        if (!action.subcategories || action.subcategories.length === 0) return { percent: 0, totalGrade: 0 };
        const totalGrade = action.subcategories.reduce((s, ev) => s + (ev.grade || 0), 0);
        const completedGrade = action.subcategories.reduce((s, ev) => {
            const c = getCompleted(appState.currentFlowId, ev.id, ev.completed);
            return s + (c ? (ev.grade || 0) : 0);
        }, 0);
        const percent = totalGrade > 0 ? (completedGrade / totalGrade) * 100 : 0;
        return { percent, totalGrade };
    };
    const calculateControlProgress = (control) => {
        if (!control.subcategories || control.subcategories.length === 0) return 0;
        const totalProgress = control.subcategories.reduce((sum, action) => sum + calculateActionProgress(action).percent, 0);
        return totalProgress / control.subcategories.length;
    };

    function renderControlNode(control, path, isFiltered, flow) {
        if (!appState.selectedActionPaths[path]) {
            const firstAction = (control.subcategories || [])[0];
            if (firstAction) {
                appState.selectedActionPaths[path] = isFiltered && firstAction._path ? firstAction._path : `${path}.subcategories.0`;
            }
        }
        const controlOriginal = isFiltered ? getObjectByPath(path, flow) : control;
        const controlProgress = calculateControlProgress(controlOriginal);

        const el = document.createElement('div');
        el.className = 'control-node';
        el.dataset.path = path;
        el.innerHTML = `
            <div class="control-header">
              <div class="control-header-top">
                <div class="control-title">${control.name}</div>
                <div class="controls creation-only">
                  <button class="btn-add" title="Add Action" data-action="add-action" data-path="${path}"><i class="fa-solid fa-plus"></i></button>
                  <button class="btn-edit" title="Edit Control Name" data-action="edit-name" data-path="${path}" data-level="control"><i class="fa-solid fa-pen"></i></button>
                  <button class="btn-add" title="Clone/Share existing" data-action="import-node" data-path="${path}" data-level="action"><i class="fa-solid fa-copy"></i></button>
                  <button class="btn-delete" title="Delete Control" data-action="delete-node" data-path="${path}" data-level="control"><i class="fa-solid fa-trash-can"></i></button>
                </div>
              </div>
              ${renderTags(getObjectByPath(path, flow), path, flow)}
              <div class="progress-bar-container"><div class="progress-bar" style="width: ${controlProgress}%;"></div></div>
            </div>
            <div class="registers-container">
                ${renderActionPanel(control, path, isFiltered, flow)}${renderEvidencePanel(control, path, isFiltered, flow)}
            </div>`;
        return el;
    }

    function renderActionPanel(control, controlPath, isFiltered, flow) {
        const actions = control.subcategories || [];
        let itemsHtml = actions.map(action => {
            const actionPath = isFiltered && action._path ? action._path :
                `${controlPath}.subcategories.${(getObjectByPath(controlPath, flow).subcategories || []).indexOf(action)}`;
            const isSelected = appState.selectedActionPaths[controlPath] === actionPath;

            const { percent, totalGrade } = calculateActionProgress(getObjectByPath(actionPath, flow));
            const validationError = totalGrade !== 5.0 && (getObjectByPath(actionPath, flow).subcategories || []).length > 0
                ? `<div class="validation-error">Grade total is ${totalGrade.toFixed(1)}/5.0</div>` : '';
            const tagsHtml = renderTags(getObjectByPath(actionPath, flow), actionPath, flow);

            return `
              <div class="action-item ${isSelected ? 'selected' : ''}" data-action="select-action" data-path="${actionPath}" data-control-path="${controlPath}">
                <div class="action-item-header">
                  <div class="action-name">${action.name}</div>
                  <div class="controls creation-only">
                    <button class="btn-add" title="Add Evidence" data-action="add-evidence" data-path="${actionPath}"><i class="fa-solid fa-plus"></i></button>
                    <button class="btn-edit" title="Edit Action" data-action="edit-name" data-path="${actionPath}" data-level="action"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn-add" title="Clone/Share existing" data-action="import-node" data-path="${actionPath}" data-level="evidence"><i class="fa-solid fa-copy"></i></button>
                    <button class="btn-delete" title="Delete Action" data-action="delete-node" data-path="${actionPath}" data-level="action"><i class="fa-solid fa-trash-can"></i></button>
                  </div>
                </div>
                <div class="action-text creation-only">${getObjectByPath(actionPath, flow).text || ''}</div>
                ${tagsHtml}
                <div class="progress-bar-container"><div class="progress-bar" style="width: ${percent}%;"></div></div>
                ${validationError}
              </div>`;
        }).join('');
        if (itemsHtml === '') itemsHtml = `<div class="empty-state">No actions yet.</div>`;
        return `<div class="action-register-panel"><h3 class="panel-title creation-only"><i class="fa-solid fa-person-running"></i> Actions</h3>${itemsHtml}</div>`;
    }

    function renderEvidencePanel(controlFilteredOrFull, controlPath, isFiltered, flow) {
        let selectedActionPath = appState.selectedActionPaths[controlPath];
        if (isFiltered) {
            const filteredActions = controlFilteredOrFull.subcategories || [];
            const filteredActionPaths = new Set(filteredActions.map(a => a._path));
            if (!filteredActionPaths.has(selectedActionPath)) {
                const first = filteredActions[0];
                selectedActionPath = first ? first._path : null;
                appState.selectedActionPaths[controlPath] = selectedActionPath;
            }
        }
        if (!selectedActionPath) {
            return `<div class="evidence-register-panel"><div class="empty-state">Select an action, or add evidence.</div></div>`;
        }

        let evidenceItems = [];
        if (isFiltered) {
            const filteredAction = (controlFilteredOrFull.subcategories || []).find(a => a._path === selectedActionPath);
            evidenceItems = filteredAction ? (filteredAction.subcategories || []) : [];
        } else {
            const fullAction = getObjectByPath(selectedActionPath, flow);
            evidenceItems = (fullAction && fullAction.subcategories) ? fullAction.subcategories : [];
        }

        const itemsHtml = evidenceItems.map(evidence => {
            const evidencePath = isFiltered && evidence._path ? evidence._path :
                selectedActionPath + `.subcategories.${(getObjectByPath(selectedActionPath, flow).subcategories || []).indexOf(evidence)}`;
            return renderEvidenceNode(getObjectByPath(evidencePath, flow), evidencePath);
        }).join('') || `<div class="empty-state">No evidence for this action${appState.activeTag ? ' with this tag' : ''}.</div>`;

        return `<div class="evidence-register-panel"><h3 class="panel-title creation-only"><i class="fa-solid fa-receipt"></i> Evidence</h3>${itemsHtml}</div>`;
    }

    function renderEvidenceNode(node, path) {
        const isDone = getCompleted(appState.currentFlowId, node.id, node.completed);
        const containerClasses = ['evidence-node'];
        if (appState.currentMode === 'execution') {
            if (node.isLocked) containerClasses.push('locked');
            if (node.isActive) containerClasses.push('active');
        }
        const gradeOptions = [0.5,1.0,1.5,2.0,2.5,3.0,3.5,4.0,4.5,5.0];
        const gradeSelector = `
            <div class="evidence-grade-selector creation-only">
                <label for="grade-${node.id}">Grade:</label>
                <select id="grade-${node.id}" data-action="change-grade" data-path="${path}">
                    ${gradeOptions.map(g => `<option value="${g}" ${node.grade === g ? 'selected' : ''}>${g.toFixed(1)}</option>`).join('')}
                </select>
            </div>`;
        let descriptionHtml = '';
        if (appState.currentMode === 'creation') {
            descriptionHtml = `<textarea class="evidence-text-creation" data-action="edit-text" data-path="${path}" placeholder="Enter description...">${node.text || ''}</textarea>`;
        } else if (node.text) {
            descriptionHtml = `<p class="evidence-text-execution">${node.text}</p>`;
        }
        const tagsHtml = renderTags(node, path, getCurrentFlow());
        const footerControlsHtml = `
            <div class="footer-controls creation-only">
                <button title="Add Link" data-action="add-attachment" data-type="link" data-path="${path}"><i class="fa-solid fa-link"></i></button>
                <button title="Add Image URL" data-action="add-attachment" data-type="image" data-path="${path}"><i class="fa-solid fa-image"></i></button>
                <button title="Add Note" data-action="add-attachment" data-type="note" data-path="${path}"><i class="fa-solid fa-book-open"></i></button>
                <button title="Add Comment" data-action="add-attachment" data-type="comment" data-path="${path}"><i class="fa-solid fa-comment"></i></button>
            </div>`;
        return `
          <div class="${containerClasses.join(' ')}" data-path="${path}">
            <div class="evidence-header">
              <div class="evidence-title ${isDone ? 'completed' : ''}">
                <input type="checkbox" class="evidence-checkbox execution-only" data-action="toggle-complete" data-path="${path}" ${isDone ? 'checked' : ''} id="checkbox-${node.id}">
                <label for="checkbox-${node.id}" class="title-label">${node.name}</label>
              </div>
              ${gradeSelector}
              <div class="controls creation-only">
                <button class="btn-manage" title="Manage Attachments" data-action="manage-attachments" data-path="${path}"><i class="fa-solid fa-gear"></i></button>
                <button class="btn-edit" title="Edit Evidence Name" data-action="edit-name" data-path="${path}" data-level="evidence"><i class="fa-solid fa-pen"></i></button>
                <button class="btn-delete" title="Delete Evidence" data-action="delete-node" data-path="${path}" data-level="evidence"><i class="fa-solid fa-trash-can"></i></button>
              </div>
            </div>
            ${descriptionHtml}
            ${tagsHtml}
            <div class="evidence-footer">
              <div class="footer-item-list">
                ${(node.footer?.links || []).map((link, i) => `<div class="footer-item" title="${getAbsoluteUrl(link.url)}" data-action="show-link-in-modal" data-path="${path}" data-index="${i}"><i class="fa-solid fa-link"></i> ${link.text}</div>`).join('')}
                ${(node.footer?.images || []).map((img, i) => `<div class="footer-item" title="View Image" data-action="show-image-in-modal" data-path="${path}" data-index="${i}"><i class="fa-solid fa-image"></i> Image ${i+1}</div>`).join('')}
                ${(node.footer?.notes || []).map((note, i) => `<div class="footer-item" title="View Note" data-action="show-note-content" data-path="${path}" data-index="${i}"><i class="fa-solid fa-book-open"></i> ${note.title}</div>`).join('')}
                <span class="execution-only">
                  ${(node.footer?.comments || []).length > 0 ? `<div class="footer-item" data-action="show-view-modal" data-type="comments" data-path="${path}"><i class="fa-solid fa-comment"></i> Comments (${node.footer.comments.length})</div>` : ''}
                </span>
              </div>
              ${footerControlsHtml}
            </div>
          </div>`;
    }

    // --- EXECUTION LOCKING (sequence) ---
    function updateAllExecutionStates(flow) {
        const enforce = appState.workflow.settings?.enforceSequence;
        (flow.data || []).forEach(control => {
            (control.subcategories || []).forEach(action => {
                let foundFirstIncomplete = false;
                (action.subcategories || []).forEach(ev => {
                    const done = getCompleted(appState.currentFlowId, ev.id, ev.completed);
                    if (!enforce) {
                        ev.isLocked = false; ev.isActive = false; return;
                    }
                    if (!foundFirstIncomplete && !done) {
                        ev.isLocked = false; ev.isActive = true; foundFirstIncomplete = true;
                    } else {
                        ev.isActive = false; ev.isLocked = foundFirstIncomplete;
                    }
                });
            });
        });
    }

    // --- ATTACHMENTS & VIEWERS ---
    const showLinkModal = (path, index) => {
        const node = getObjectByPath(path, getCurrentFlow());
        const link = node.footer.links[index];
        const safeUrl = getAbsoluteUrl(link.url);
        openModal(link.text, `
            <div class="modal-link-container">
                <iframe src="${safeUrl}" class="modal-link-frame" sandbox="allow-scripts allow-same-origin"></iframe>
                <div class="modal-link-actions">
                    <a href="${safeUrl}" target="_blank" class="open-external"><i class="fa-solid fa-up-right-from-square"></i> Open in New Tab</a>
                </div>
            </div>
        `);
    };
    const showViewOnlyModal = (path, type) => {
        const node = getObjectByPath(path, getCurrentFlow());
        const { images = [], comments = [] } = node.footer || {};
        if (type === 'images') {
            openModal(`Images for: ${node.name}`, `<div class="modal-gallery">${images.map(img => `<img class="modal-gallery-image" src="${getAbsoluteUrl(img)}" alt="Workflow Image">`).join('')}</div>`);
        } else if (type === 'comments') {
            openModal(`Comments for: ${node.name}`, `<ul class="modal-list">${comments.map(c => `<li class="modal-item"><span class="modal-item-text">${c}</span></li>`).join('')}</ul>`);
        }
    };

    function renderModalList(items, path, type) {
        if (!items || items.length === 0) return `<div class="empty-state">No ${type}s added yet.</div>`;
        return `<ul class="modal-list">${
            items.map((item, index) => {
                let itemText;
                if (type === 'link') itemText = `<a href="${getAbsoluteUrl(item.url)}" target="_blank">${item.text}</a> <span class="url-preview">(${item.url})</span>`;
                else if (type === 'image') itemText = `<div class="image-preview"><img src="${getAbsoluteUrl(item)}" alt="preview" /> ${item}</div>`;
                else if (type === 'note') itemText = item.title || 'Untitled Note';
                else itemText = item;
                return `
                    <li class="modal-item">
                        <div class="modal-item-text">${itemText}</div>
                        <div class="modal-item-controls">
                            <button class="btn-edit" title="Edit" data-action="edit-${type}" data-path="${path}" data-index="${index}"><i class="fa-solid fa-pen"></i></button>
                            <button class="btn-delete" title="Delete" data-action="delete-${type}" data-path="${path}" data-index="${index}"><i class="fa-solid fa-trash-can"></i></button>
                        </div>
                    </li>`;
            }).join('')
        }</ul>`;
    }
    const showManagementModal = (path) => {
        const node = getObjectByPath(path, getCurrentFlow());
        const { links = [], images = [], notes = [], comments = [] } = node.footer || {};
        const linksHtml = `<div class="modal-section"><h4><i class="fa-solid fa-link"></i> Links</h4>${renderModalList(links, path, 'link')}</div>`;
        const imagesHtml = `<div class="modal-section"><h4><i class="fa-solid fa-image"></i> Images</h4>${renderModalList(images, path, 'image')}</div>`;
        const notesHtml = `<div class="modal-section"><h4><i class="fa-solid fa-book-open"></i> Notes</h4>${renderModalList(notes, path, 'note')}</div>`;
        const commentsHtml = `<div class="modal-section"><h4><i class="fa-solid fa-comment"></i> Comments</h4>${renderModalList(comments, path, 'comment')}</div>`;
        openModal(`Manage Attachments for: ${node.name}`, linksHtml + imagesHtml + notesHtml + commentsHtml);
    };
    const showAddAttachmentModal = (path, type) => {
        const title = `Add New ${type==='note'?'Note':type[0].toUpperCase()+type.slice(1)}`;
        let formHtml = `<form class="modal-form" data-action="submit-attachment" data-path="${path}" data-type="${type}">`;
        if (type === 'link') {
            formHtml += `<label for="modal-input-url">URL</label><input type="text" id="modal-input-url" placeholder="e.g., google.com" required>
                         <label for="modal-input-text">Link Text</label><input type="text" id="modal-input-text" placeholder="e.g., Google Search" required>`;
        } else if (type === 'image') {
            formHtml += `<label for="modal-input-url">Image URL or Path</label><input type="text" id="modal-input-url" placeholder="https://example.com/image.png" required>`;
        } else if (type === 'comment') {
            formHtml += `<label for="modal-input-text">Comment</label><textarea id="modal-input-text" required></textarea>`;
        } else if (type === 'note') {
            formHtml += `<label for="modal-input-text">Note Title</label><input type="text" id="modal-input-text" placeholder="e.g., Important Details" required>
                         <div id="quill-editor-container"><div id="quill-editor"></div></div>`;
        }
        formHtml += `<div class="modal-form-actions"><button type="button" class="cancel" data-action="cancel-modal">Cancel</button><button type="submit" class="save">Save</button></div></form>`;
        openModal(title, formHtml, () => { if (type === 'note') { quillEditor = new Quill('#quill-editor', { theme: 'snow' }); } });
    };

    // --- GLOBAL FILTER (cross-flow) with tag autocomplete ---
    const openGlobalTagFilter = () => {
        const flowChecks = appState.workflow.flows.map(f =>
            `<label style="display:flex;gap:.5rem;align-items:center;"><input type="checkbox" class="global-flow-check" value="${f.id}" checked> ${f.name}</label>`
        ).join('');

        const body = `
            <form id="global-filter-form" class="modal-form">
                <div><strong>Flows</strong></div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.5rem;margin:.5rem 0 1rem;">${flowChecks}</div>
                <label>Tags (comma-separated)</label>
                <input type="text" id="global-tags" placeholder="e.g. firewall, training" autocomplete="off">
                <datalist id="global-tags-datalist"></datalist>
                <div class="modal-form-actions">
                    <button type="button" class="cancel" data-action="cancel-modal">Close</button>
                    <button type="submit" class="save">Filter</button>
                </div>
            </form>
            <div id="global-results" style="margin-top:1rem;"></div>
        `;
        openModal('Cross-flow Tag Filter', body, () => {
            const form = document.getElementById('global-filter-form');
            const input = document.getElementById('global-tags');
            const datalist = document.getElementById('global-tags-datalist');

            const collectTags = (flowIds) => {
                const set = new Set();
                appState.workflow.flows.filter(f => flowIds.includes(f.id)).forEach(flow => {
                    (flow.data || []).forEach(ctl => {
                        (ctl.tags || []).forEach(t => set.add(t));
                        (ctl.subcategories || []).forEach(act => {
                            (act.tags || []).forEach(t => set.add(t));
                            (act.subcategories || []).forEach(ev => (ev.tags || []).forEach(t => set.add(t)));
                        });
                    });
                });
                return Array.from(set).sort((a, b) => a.localeCompare(b));
            };

            const refreshDatalist = () => {
                const selectedFlows = Array.from(document.querySelectorAll('.global-flow-check:checked')).map(i => i.value);
                const tags = collectTags(selectedFlows);
                // Suggest based on last token typed
                const raw = input.value;
                const last = raw.split(',').pop().trim().toLowerCase();
                const candidates = last ? tags.filter(t => t.toLowerCase().includes(last)) : tags;
                datalist.innerHTML = candidates.map(t => `<option value="${t}"></option>`).join('');
                input.setAttribute('list', 'global-tags-datalist');
            };

            document.querySelectorAll('.global-flow-check').forEach(cb => cb.addEventListener('change', refreshDatalist));
            input.addEventListener('input', refreshDatalist);
            refreshDatalist();

            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const selectedFlows = Array.from(document.querySelectorAll('.global-flow-check:checked')).map(i => i.value);
                const tags = (document.getElementById('global-tags').value || '')
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean);
                runGlobalFilter(selectedFlows, tags);
            });
        });
    };

    const runGlobalFilter = (flowIds, tags) => {
        const results = new Map(); // key by node shareKey or id
        const keyFor = (node) => node.shareKey || node.id;

        appState.workflow.flows.filter(f => flowIds.includes(f.id)).forEach(flow => {
            (flow.data || []).forEach(ctl => {
                const ctlMatch = tags.length === 0 ? false : (ctl.tags || []).some(t => tags.includes(t));
                (ctl.subcategories || []).forEach(act => {
                    const actMatch = tags.length === 0 ? false : (act.tags || []).some(t => tags.includes(t)) || ctlMatch;
                    (act.subcategories || []).forEach(ev => {
                        const evMatch = tags.length === 0 ? false : (ev.tags || []).some(t => tags.includes(t)) || actMatch;
                        if (ctlMatch || actMatch || evMatch) {
                            const node = evMatch ? ev : (actMatch ? act : ctl);
                            const k = keyFor(node);
                            const label = evMatch ? `Evidence: ${ev.name}` : actMatch ? `Action: ${act.name}` : `Control: ${ctl.name}`;
                            const existing = results.get(k);
                            const flowName = flow.name;
                            if (existing) {
                                existing.flows.add(flowName);
                            } else {
                                results.set(k, { label, flows: new Set([flowName]) });
                            }
                        }
                    });
                });
            });
        });

        const target = document.getElementById('global-results');
        if (!results.size) {
            target.innerHTML = `<div class="empty-state">No matches.</div>`;
            return;
        }
        target.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:.5rem;">
                ${Array.from(results.values()).map(r => `
                    <div class="modal-item">
                        <div class="modal-item-text">${r.label}</div>
                        <div class="modal-item-text" style="font-size:.85rem;color:var(--text-muted-color)">
                            Shared in: ${Array.from(r.flows).join(', ')}
                        </div>
                    </div>`).join('')}
            </div>
        `;
    };

    // --- EVENTS / ACTIONS ---
    function handleAppClick(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;

        const action = btn.dataset.action;
        const path = btn.dataset.path;
        const index = btn.dataset.index;
        const type = btn.dataset.type;
        const level = btn.dataset.level;
        const controlPath = btn.dataset.controlPath;
        const flow = getCurrentFlow();

        // Restrict: creation-only actions are gated also in JS
        const creationOnlyActions = new Set([
            'add-category', 'add-action', 'add-evidence',
            'edit-name', 'delete-node',
            'add-attachment', 'manage-attachments', 'import-node'
        ]);
        if (appState.currentMode !== 'creation' && creationOnlyActions.has(action)) return;

        // Allowed interactions in execution
        const allowedExecution = [
            'toggle-complete','show-link-in-modal','show-image-in-modal','show-note-content','show-view-modal',
            'select-action','cancel-modal','filter-by-tag','clear-tag-filter'
        ];
        if (appState.currentMode === 'execution' && !allowedExecution.includes(action)) return;

        let shouldRender = true;
        const node = path ? getObjectByPath(path, flow) : null;

        const actions = {
            // ----- STRUCTURE -----
            'add-category': () => {
                const n = prompt("Enter new Control name:");
                if (!n) return;
                flow.data = flow.data || [];
                const ctl = { id: generateId('cat'), name: n, text: '', tags: [], subcategories: [] };
                flow.data.push(ctl);
                openDistributeNewNodeModal({ node: ctl, level: 'control', flow });
            },
            'add-action': () => {
                const n = prompt("Enter new Action name:");
                if (!n) return;
                node.subcategories = node.subcategories || [];
                const act = { id: generateId('act'), name: n, text: '', tags: [], completed: false, subcategories: [] };
                node.subcategories.push(act);
                openDistributeNewNodeModal({ node: act, level: 'action', flow, parentPath: path });
            },
            'add-evidence': () => {
                const n = prompt("Enter new Evidence name:");
                if (!n) return;
                node.subcategories = node.subcategories || [];
                const evi = {
                    id: generateId('evi'),
                    name: n, text: '', completed: false, grade: 1.0, tags: [],
                    footer: { links: [], images: [], notes: [], comments: [] },
                    subcategories: []
                };
                node.subcategories.push(evi);
                openDistributeNewNodeModal({ node: evi, level: 'evidence', flow, parentPath: path });
            },
            'edit-name': () => {
                const n = prompt("Enter new name:", node.name);
                if (n === null) return;
                node.name = n;
                const lvl = btn.dataset.level;
                if (lvl) propagateSharedEdit(node, lvl);
            },
            'delete-node': () => {
                const { parent, key } = getParentAndKey(path, flow);
                if (!confirm(`Delete "${node.name}"?`)) return;
                const shareKey = node.shareKey;
                const lvl = btn.dataset.level;
                parent.splice(key, 1);
                if (shareKey) propagateSharedDelete(shareKey, lvl);
                reconcileExecution(appState.currentFlowId);
                reconcileAllExecutions();
            },
            'select-action': () => { appState.selectedActionPaths[controlPath] = path; },

            // ----- IMPORT / CLONE / SHARE (creation only) -----
            'import-node': () => {
                const lvl = btn.dataset.level; // import actions into control OR evidences into action
                openImportModal(path, lvl);
                shouldRender = false;
            },

            // ----- ATTACHMENTS -----
            'add-attachment': () => { showAddAttachmentModal(path, type); shouldRender = false; },
            'manage-attachments': () => { showManagementModal(path); shouldRender = false; },
            'show-link-in-modal': () => { showLinkModal(path, index); shouldRender = false; },
            'show-image-in-modal': () => { showViewOnlyModal(path, 'images'); shouldRender = false; },
            'show-note-content': () => {
                const nNote = node.footer.notes[index];
                openModal(nNote.title, `<div class="note-view-content ql-snow"><div class="ql-editor">${nNote.content}</div></div>`);
                shouldRender = false;
            },
            'show-view-modal': () => {
                const modalType = btn.dataset.type;
                showViewOnlyModal(path, modalType);
                shouldRender = false;
            },
            'cancel-modal': () => { closeModal(); shouldRender = false; },

            // ----- TAGS -----
            'delete-tag': () => { ensureTagsArray(node).splice(parseInt(index, 10), 1); },
            'filter-by-tag': () => { appState.activeTag = btn.dataset.tag; },
            'clear-tag-filter': () => { appState.activeTag = null; },
        };

        if (actions[action]) {
            actions[action]();
            updateAllExecutionStates(flow);
            if (shouldRender) render();
        }
    }

    function handleAppChange(e) {
        const t = e.target;
        const target = t.closest('[data-action]');
        const flow = getCurrentFlow();
        if (!target) return;

        const action = target.dataset.action;
        if (action === 'toggle-complete') {
            const node = getObjectByPath(target.dataset.path, flow);
            setCompleted(appState.currentFlowId, node.id, t.checked);
            // synchronize across flows if shared
            if (node.shareKey) {
                propagateSharedExecution(node.shareKey, t.checked);
            }
            updateAllExecutionStates(flow);
            render();
        } else if (action === 'change-grade') {
            // Grade is structural (creation) and syncs for shared nodes
            const node = getObjectByPath(target.dataset.path, flow);
            node.grade = parseFloat(t.value);
            propagateSharedEdit(node, 'evidence');
            render();
        }
    }

    // text edit (creation)
    document.addEventListener('input', (e) => {
        const ta = e.target.closest('textarea[data-action="edit-text"]');
        if (!ta) return;
        const flow = getCurrentFlow();
        const node = getObjectByPath(ta.dataset.path, flow);
        node.text = ta.value;
        const parts = ta.dataset.path.split('.');
        const lvl = parts.includes('subcategories') ? (parts.filter(p=>p==='subcategories').length===2?'evidence':'action') : 'control';
        propagateSharedEdit(node, lvl);
    });

    // tag add (enter)
    document.addEventListener('keydown', (e) => {
        const input = e.target;
        if (input && input.matches('.add-tag-input') && e.key === 'Enter') {
            e.preventDefault();
            const flow = getCurrentFlow();
            const path = input.dataset.path;
            const node = getObjectByPath(path, flow);
            const val = (input.value || '').trim();
            if (!val) return;
            const tags = ensureTagsArray(node);
            if (!tags.includes(val)) tags.push(val);
            input.value = '';
            const parts = path.split('.');
            const lvl = parts.filter(p => p === 'subcategories').length === 0 ? 'control'
                : parts.filter(p => p === 'subcategories').length === 1 ? 'action' : 'evidence';
            propagateSharedEdit(node, lvl);
            render();
        }
    });

    // attachment forms
    document.addEventListener('submit', (e) => {
        const form = e.target.closest('form[data-action="submit-attachment"]');
        if (!form) return;
        e.preventDefault();
        const flow = getCurrentFlow();
        const path = form.dataset.path;
        const type = form.dataset.type;
        const node = getObjectByPath(path, flow);
        node.footer = node.footer || { links: [], images: [], notes: [], comments: [] };
        if (type === 'link') {
            const url = document.getElementById('modal-input-url').value.trim();
            const text = document.getElementById('modal-input-text').value.trim();
            if (url && text) node.footer.links.push({ url, text });
        } else if (type === 'image') {
            const url = document.getElementById('modal-input-url').value.trim();
            if (url) node.footer.images.push(url);
        } else if (type === 'comment') {
            const text = document.getElementById('modal-input-text').value.trim();
            if (text) node.footer.comments.push(text);
        } else if (type === 'note') {
            const title = document.getElementById('modal-input-text').value.trim();
            const content = quillEditor ? quillEditor.root.innerHTML : '';
            node.footer.notes.push({ title, content });
        }
        closeModal();
        render();
    });

    // edit/delete inside modal lists
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.modal-item-controls [data-action]');
        if (!btn) return;
        const { action, path, index } = btn.dataset;
        const flow = getCurrentFlow();
        const node = getObjectByPath(path, flow);
        if (!node || !node.footer) return;

        if (action === 'delete-link') node.footer.links.splice(index, 1);
        else if (action === 'delete-image') node.footer.images.splice(index, 1);
        else if (action === 'delete-comment') node.footer.comments.splice(index, 1);
        else if (action === 'delete-note') node.footer.notes.splice(index, 1);
        else if (action === 'edit-link') {
            const item = node.footer.links[index];
            const newUrl = prompt('Edit URL:', item.url);
            const newText = prompt('Edit text:', item.text);
            if (newUrl !== null && newText !== null) { item.url = newUrl; item.text = newText; }
        } else if (action === 'edit-image') {
            const newUrl = prompt('Edit image URL:', node.footer.images[index]);
            if (newUrl !== null) node.footer.images[index] = newUrl;
        } else if (action === 'edit-comment') {
            const newText = prompt('Edit comment:', node.footer.comments[index]);
            if (newText !== null) node.footer.comments[index] = newText;
        } else if (action === 'edit-note') {
            const note = node.footer.notes[index];
            openModal('Edit Note', `
              <form class="modal-form" data-action="submit-edit-note" data-path="${path}" data-index="${index}">
                <label for="modal-input-text">Note Title</label>
                <input type="text" id="modal-input-text" value="${note.title}">
                <div id="quill-editor-container"><div id="quill-editor"></div></div>
                <div class="modal-form-actions">
                  <button type="button" class="cancel" data-action="cancel-modal">Cancel</button>
                  <button type="submit" class="save">Save</button>
                </div>
              </form>
            `, () => { quillEditor = new Quill('#quill-editor', { theme: 'snow' }); quillEditor.root.innerHTML = note.content; });
            return;
        }
        showManagementModal(path);
    });

    document.addEventListener('submit', (e) => {
        const form = e.target.closest('form[data-action="submit-edit-note"]');
        if (!form) return;
        e.preventDefault();
        const flow = getCurrentFlow();
        const path = form.dataset.path;
        const idx = parseInt(form.dataset.index, 10);
        const node = getObjectByPath(path, flow);
        const title = document.getElementById('modal-input-text').value.trim();
        const content = quillEditor ? quillEditor.root.innerHTML : '';
        node.footer.notes[idx] = { title, content };
        closeModal();
        showManagementModal(path);
    });

    // --- IMPORT MODAL (clone/share existing nodes at same level into current flow) ---
    function openImportModal(targetPath, level) {
        const items = [];
        appState.workflow.flows.forEach(flow => {
            if (level === 'action') {
                (flow.data || []).forEach(ctl => items.push({ flow, level, node: ctl }));
            } else if (level === 'evidence') {
                (flow.data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => items.push({ flow, level, node: act })));
            }
        });
        const rows = items.map((it, i) => `<option value="${i}">${it.flow.name} • ${it.level === 'action' ? 'Control' : 'Action'}: ${it.node.name}</option>`).join('');
        const body = `
            <form id="import-form" class="modal-form">
                <label>Select source ${level === 'action' ? 'Control' : 'Action'}</label>
                <select id="import-source">${rows}</select>
                <div style="display:flex;gap:.5rem;margin-top:.5rem;">
                    <label><input type="radio" name="import-mode" value="clone" checked> Clone</label>
                    <label><input type="radio" name="import-mode" value="share"> Share</label>
                </div>
                <div class="modal-form-actions">
                    <button type="button" class="cancel" data-action="cancel-modal">Cancel</button>
                    <button type="submit" class="save">Import</button>
                </div>
            </form>
        `;
        openModal(`Import ${level === 'action' ? 'Action group from Control' : 'Evidence from Action'}`, body, () => {
            const form = document.getElementById('import-form');
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const idx = parseInt(document.getElementById('import-source').value, 10);
                const mode = form.querySelector('input[name="import-mode"]:checked').value;
                const source = items[idx];
                const targetFlow = getCurrentFlow();

                if (level === 'action') {
                    const targetCtl = getObjectByPath(targetPath, targetFlow);
                    targetCtl.subcategories = targetCtl.subcategories || [];
                    (source.node.subcategories || []).forEach(act => {
                        const newNode = JSON.parse(JSON.stringify(act));
                        if (mode === 'clone') {
                            newNode.id = generateId('act');
                            (newNode.subcategories || []).forEach(ev => ev.id = generateId('evi'));
                            delete newNode.shareKey;
                        } else {
                            setShareKeyDeep(newNode, act.shareKey || act.id);
                        }
                        targetCtl.subcategories.push(newNode);
                    });
                } else if (level === 'evidence') {
                    const targetAct = getObjectByPath(targetPath, targetFlow);
                    targetAct.subcategories = targetAct.subcategories || [];
                    (source.node.subcategories || []).forEach(ev => {
                        const newNode = JSON.parse(JSON.stringify(ev));
                        if (mode === 'clone') {
                            newNode.id = generateId('evi');
                            delete newNode.shareKey;
                        } else {
                            setShareKeyDeep(newNode, ev.shareKey || ev.id);
                        }
                        targetAct.subcategories.push(newNode);
                    });
                }
                closeModal();
                render();
            });
        });
    }

    // --- DISTRIBUTE NEW NODE (copy/share to other flows) ---
    function openDistributeNewNodeModal({ node, level, flow, parentPath }) {
        const otherFlows = appState.workflow.flows.filter(f => f.id !== flow.id);
        if (otherFlows.length === 0) return; // nothing to distribute to

        const rows = otherFlows.map(f => `<label style="display:flex;gap:.5rem;align-items:center;"><input type="checkbox" class="dist-flow" value="${f.id}"> ${f.name}</label>`).join('');
        const body = `
            <form id="dist-form" class="modal-form">
                <div><strong>Distribute "${node.name}" to:</strong></div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.5rem;margin:.5rem 0 1rem;">${rows}</div>
                <div style="display:flex;gap:.5rem;margin-top:.5rem;">
                    <label><input type="radio" name="dist-mode" value="copy" checked> Copy</label>
                    <label><input type="radio" name="dist-mode" value="share"> Share</label>
                </div>
                <div class="modal-form-actions">
                    <button type="button" class="cancel" data-action="cancel-modal">Skip</button>
                    <button type="submit" class="save">Apply</button>
                </div>
            </form>
            <div id="dist-result" style="margin-top:1rem;"></div>
        `;
        openModal(`Distribute new ${level}`, body, () => {
            const form = document.getElementById('dist-form');
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const mode = form.querySelector('input[name="dist-mode"]:checked').value;
                const selected = Array.from(document.querySelectorAll('.dist-flow:checked')).map(i => i.value);
                const result = { added: [], skipped: [] };

                // helper: find chain in target flow
                const findControlIn = (targetFlow, srcCtl) => {
                    // prefer shareKey; fallback name
                    const key = srcCtl.shareKey;
                    let found = (targetFlow.data || []).find(c => key ? c.shareKey === key : c.name === srcCtl.name);
                    return found || null;
                };
                const findActionIn = (targetFlow, srcCtl, srcAct) => {
                    const ctl = findControlIn(targetFlow, srcCtl);
                    if (!ctl) return null;
                    const key = srcAct.shareKey;
                    let found = (ctl.subcategories || []).find(a => key ? a.shareKey === key : a.name === srcAct.name);
                    return found || null;
                };

                // resolve parent chain from parentPath (for action/evidence levels)
                let srcCtl = null, srcAct = null;
                if (level !== 'control' && parentPath) {
                    const parts = parentPath.split('.');
                    if (level === 'action') {
                        // parent is control at parentPath
                        srcCtl = getObjectByPath(parentPath, flow);
                    } else if (level === 'evidence') {
                        // parentPath is action path; need action + its control
                        srcAct = getObjectByPath(parentPath, flow);
                        const ctlIndex = parentPath.split('.').slice(0, 2).join('.');
                        // ctlIndex is "data.X" but we need the actual node; derive properly:
                        // parentPath: data.ci.subcategories.ai
                        const ci = parseInt(parentPath.split('.')[1], 10);
                        srcCtl = (flow.data || [])[ci];
                    }
                }

                selected.forEach(fid => {
                    const targetFlow = appState.workflow.flows.find(f => f.id === fid);
                    if (!targetFlow) return;

                    if (level === 'control') {
                        const newNode = JSON.parse(JSON.stringify(node));
                        if (mode === 'copy') {
                            newNode.id = generateId('cat');
                            (newNode.subcategories || []).forEach(a => { a.id = generateId('act'); (a.subcategories || []).forEach(e => e.id = generateId('evi')); });
                            delete newNode.shareKey; (newNode.subcategories || []).forEach(a => { delete a.shareKey; (a.subcategories||[]).forEach(e=>delete e.shareKey); });
                        } else {
                            setShareKeyDeep(newNode, node.shareKey || node.id);
                        }
                        targetFlow.data = targetFlow.data || [];
                        targetFlow.data.push(newNode);
                        // execution share: if "share", also mirror completed states for any evidence inside
                        if (mode === 'share') {
                            (newNode.subcategories || []).forEach(a => (a.subcategories || []).forEach(ev => {
                                const idx = sharedEvidenceIndex();
                                const group = idx.get(ev.shareKey);
                                const srcEntry = group?.find(g => g.flowId === flow.id);
                                if (srcEntry) {
                                    const val = ensureExecFlow(flow.id).completed[srcEntry.evidenceId];
                                    if (typeof val === 'boolean') setCompleted(fid, ev.id, val);
                                }
                            }));
                        }
                        result.added.push(`${targetFlow.name}`);
                    } else if (level === 'action') {
                        const ctlInTarget = findControlIn(targetFlow, srcCtl);
                        if (!ctlInTarget) {
                            result.skipped.push(`${targetFlow.name} (missing parent Control)`);
                            return;
                        }
                        const newNode = JSON.parse(JSON.stringify(node));
                        if (mode === 'copy') {
                            newNode.id = generateId('act');
                            (newNode.subcategories || []).forEach(e => e.id = generateId('evi'));
                            delete newNode.shareKey; (newNode.subcategories || []).forEach(e=>delete e.shareKey);
                        } else {
                            setShareKeyDeep(newNode, node.shareKey || node.id);
                        }
                        ctlInTarget.subcategories = ctlInTarget.subcategories || [];
                        ctlInTarget.subcategories.push(newNode);
                        if (mode === 'share') {
                            (newNode.subcategories || []).forEach(ev => {
                                const idx = sharedEvidenceIndex();
                                const group = idx.get(ev.shareKey);
                                const srcEntry = group?.find(g => g.flowId === flow.id);
                                if (srcEntry) {
                                    const val = ensureExecFlow(flow.id).completed[srcEntry.evidenceId];
                                    if (typeof val === 'boolean') setCompleted(fid, ev.id, val);
                                }
                            });
                        }
                        result.added.push(`${targetFlow.name}`);
                    } else if (level === 'evidence') {
                        const actInTarget = findActionIn(targetFlow, srcCtl, srcAct);
                        if (!actInTarget) {
                            result.skipped.push(`${targetFlow.name} (missing parent Control/Action)`);
                            return;
                        }
                        const newNode = JSON.parse(JSON.stringify(node));
                        if (mode === 'copy') {
                            newNode.id = generateId('evi'); delete newNode.shareKey;
                        } else {
                            setShareKeyDeep(newNode, node.shareKey || node.id);
                        }
                        actInTarget.subcategories = actInTarget.subcategories || [];
                        actInTarget.subcategories.push(newNode);

                        if (mode === 'share') {
                            // mirror current completion to target
                            const curVal = ensureExecFlow(flow.id).completed[node.id];
                            if (typeof curVal === 'boolean') setCompleted(fid, newNode.id, curVal);
                        }
                        result.added.push(`${targetFlow.name}`);
                    }
                });

                // Show summary
                const out = [];
                if (result.added.length) out.push(`<div class="modal-item"><div class="modal-item-text"><strong>Added to:</strong> ${result.added.join(', ')}</div></div>`);
                if (result.skipped.length) out.push(`<div class="modal-item"><div class="modal-item-text"><strong>Skipped:</strong> ${result.skipped.join('; ')}</div></div>`);
                document.getElementById('dist-result').innerHTML = out.join('') || `<div class="empty-state">No target flow selected.</div>`;
            });
        });
    }

    // --- FLOW MANAGEMENT (new / clone / share / rename / delete) ---
    function openNewFlowModal() {
        if (appState.currentMode !== 'creation') return; // guard
        const flowsOptions = appState.workflow.flows.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
        const body = `
            <form id="new-flow-form" class="modal-form">
                <label>Flow name</label>
                <input type="text" id="new-flow-name" placeholder="My Flow" required>
                <div style="margin-top:.5rem;">
                    <label><input type="radio" name="new-flow-mode" value="empty" checked> New empty flow</label><br>
                    <label><input type="radio" name="new-flow-mode" value="clone"> Clone existing flow</label><br>
                    <label><input type="radio" name="new-flow-mode" value="share"> Share existing flow</label>
                </div>
                <div id="source-flow-block" style="margin-top:.5rem;">
                    <label>Source flow (for clone/share)</label>
                    <select id="source-flow-select">${flowsOptions}</select>
                </div>
                <div class="modal-form-actions">
                    <button type="button" class="cancel" data-action="cancel-modal">Cancel</button>
                    <button type="submit" class="save">Create</button>
                </div>
            </form>
        `;
        openModal('Create Flow', body, () => {
            const form = document.getElementById('new-flow-form');
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const name = (document.getElementById('new-flow-name').value || '').trim();
                const mode = form.querySelector('input[name="new-flow-mode"]:checked').value;
                const srcId = document.getElementById('source-flow-select').value;
                const id = generateId('flow');

                let data = [];
                if (mode === 'clone' || mode === 'share') {
                    const src = appState.workflow.flows.find(f => f.id === srcId);
                    data = JSON.parse(JSON.stringify(src.data || []));
                    if (mode === 'clone') {
                        // regenerate IDs
                        data.forEach(ctl => {
                            ctl.id = generateId('cat');
                            (ctl.subcategories || []).forEach(act => {
                                act.id = generateId('act');
                                (act.subcategories || []).forEach(ev => ev.id = generateId('evi'));
                            });
                            delete ctl.shareKey;
                            (ctl.subcategories || []).forEach(a => { delete a.shareKey; (a.subcategories||[]).forEach(e=>delete e.shareKey); });
                        });
                    } else {
                        // share: assign shareKey to each node tree
                        data.forEach(ctl => setShareKeyDeep(ctl, ctl.shareKey || ctl.id));
                        (data || []).forEach(ctl => (ctl.subcategories || []).forEach(act => {
                            if (!act.shareKey) setShareKeyDeep(act, act.id);
                            (act.subcategories || []).forEach(ev => { if (!ev.shareKey) setShareKeyDeep(ev, ev.id); });
                        }));
                    }
                }
                appState.workflow.flows.push({ id, name, data });
                appState.currentFlowId = id;

                // Execution inheritance for "share" mode
                if (mode === 'share') initializeSharedExecutionFromSource(id, srcId);

                closeModal();
                render();
            });
        });
    }

    function renameCurrentFlow() {
        if (appState.currentMode !== 'creation') return; // guard
        const flow = getCurrentFlow();
        if (!flow) return;
        const n = prompt('Flow name:', flow.name);
        if (n !== null) { flow.name = n; render(); }
    }

    function deleteCurrentFlow() {
        if (appState.currentMode !== 'creation') return; // guard
        const flow = getCurrentFlow();
        if (!flow) return;
        if (!confirm(`Delete flow "${flow.name}"?`)) return;
        // clean execution for this flow
        delete appState.executions.flows[flow.id];
        appState.workflow.flows = appState.workflow.flows.filter(f => f.id !== flow.id);
        appState.currentFlowId = appState.workflow.flows[0]?.id || null;
        render();
    }

    // --- INIT ---
    function initializeState() {
        // Theme
        const storedTheme = localStorage.getItem('workflowTheme');
        applyTheme(storedTheme || 'light');

        // Mode
        const storedMode = localStorage.getItem('workflowMode');
        appState.currentMode = storedMode || 'execution';
        document.body.classList.toggle('creation-mode', appState.currentMode === 'creation');
        document.body.classList.toggle('execution-mode', appState.currentMode === 'execution');

        const flow = getCurrentFlow();
        updateAllExecutionStates(flow);
        reconcileExecution(appState.currentFlowId);
        render();
    }

    // --- TOP-LEVEL WIRING ---
    themeToggleBtn?.addEventListener('click', toggleTheme);
    modeSwitch?.addEventListener('change', () => {
        appState.currentMode = modeSwitch.checked ? 'execution' : 'creation';
        localStorage.setItem('workflowMode', appState.currentMode);
        document.body.classList.toggle('creation-mode', appState.currentMode === 'creation');
        document.body.classList.toggle('execution-mode', appState.currentMode === 'execution');
        render();
    });

    enforceSequenceCheckbox?.addEventListener('change', () => {
        if (appState.currentMode !== 'creation') return; // sequence setting is a structure-level toggle
        appState.workflow.settings.enforceSequence = enforceSequenceCheckbox.checked;
        updateAllExecutionStates(getCurrentFlow());
        render();
    });

    saveStructureBtn?.addEventListener('click', () => { if (appState.currentMode === 'creation') saveStructure(); });
    saveExecutionBtn?.addEventListener('click', () => { if (appState.currentMode === 'execution') saveExecution(); });

    flowSelect?.addEventListener('change', (e) => {
        appState.currentFlowId = e.target.value;
        appState.activeTag = null;
        render();
    });
    flowNewBtn?.addEventListener('click', openNewFlowModal);
    flowRenameBtn?.addEventListener('click', renameCurrentFlow);
    flowDeleteBtn?.addEventListener('click', deleteCurrentFlow);
    globalTagFilterBtn?.addEventListener('click', openGlobalTagFilter);

    // banner clear
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('#clear-tag-filter');
        if (btn) { appState.activeTag = null; render(); }
    });

    // Global click/change listeners
    document.addEventListener('click', handleAppClick);
    document.addEventListener('change', handleAppChange);

    // Modal close
    modal.closeBtn.addEventListener('click', closeModal);
    modal.backdrop.addEventListener('click', (e) => { if (e.target === modal.backdrop) closeModal(); });

    // LOAD
    loadAll();
});
