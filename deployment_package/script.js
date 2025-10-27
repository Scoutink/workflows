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

    // --- NEW REFERENCE-BASED APP STATE ---
    let appState = {
        // Global item registry - single source of truth
        items: {},
        
        // Flow structure with references
        flows: {},
        
        // Hierarchical relationships
        itemHierarchy: {},
        
        // Unified execution data by item ID
        executions: {},
        
        // UI state (unchanged)
        currentFlowId: null,
        currentMode: 'execution',
        selectedActionPaths: {},
        expandedTextAreas: new Set(),
        activeTag: null,
        theme: 'light'
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

    // --- CORE ITEM MANAGEMENT ---
    
    // Create new item
    const createItem = (type, data, parentId = null) => {
        const id = generateId(type === 'control' ? 'ctl' : type === 'action' ? 'act' : 'evi');
        const item = {
            id,
            type,
            name: data.name || '',
            text: data.text || '',
            tags: data.tags || [],
            grade: data.grade,
            footer: data.footer || { links: [], images: [], notes: [], comments: [] },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            isShared: false,
            originalId: null,
            shareGroup: null
        };
        
        appState.items[id] = item;
        
        // Initialize hierarchy
        appState.itemHierarchy[id] = {
            parentId: parentId,
            childRefs: [],
            flowRefs: []
        };
        
        // Initialize execution data
        appState.executions[id] = {
            completed: false,
            grade: data.grade,
            completedAt: null,
            completedBy: null
        };
        
        if (parentId) {
            addChildToParent(parentId, id);
        }
        
        return item;
    };

    // Get item by ID
    const getItem = (id) => appState.items[id];

    // Update item
    const updateItem = (id, updates) => {
        if (appState.items[id]) {
            appState.items[id] = {
                ...appState.items[id],
                ...updates,
                updatedAt: Date.now()
            };
            
            // Notify all flows that reference this item
            notifyItemUpdate(id);
        }
    };

    // Delete item
    const deleteItem = (id) => {
        const item = appState.items[id];
        if (!item) return;
        
        // Remove from all flows
        removeItemFromAllFlows(id);
        
        // Remove children recursively
        const hierarchy = appState.itemHierarchy[id];
        if (hierarchy) {
            hierarchy.childRefs.forEach(childId => deleteItem(childId));
        }
        
        // Remove from registry
        delete appState.items[id];
        delete appState.itemHierarchy[id];
        delete appState.executions[id];
    };

    // Add child to parent
    const addChildToParent = (parentId, childId) => {
        if (appState.itemHierarchy[parentId]) {
            appState.itemHierarchy[parentId].childRefs.push(childId);
        }
    };

    // Remove child from parent
    const removeChildFromParent = (parentId, childId) => {
        if (appState.itemHierarchy[parentId]) {
            const index = appState.itemHierarchy[parentId].childRefs.indexOf(childId);
            if (index > -1) {
                appState.itemHierarchy[parentId].childRefs.splice(index, 1);
            }
        }
    };

    // Add flow reference to item
    const addFlowReference = (itemId, flowId) => {
        if (appState.itemHierarchy[itemId]) {
            if (!appState.itemHierarchy[itemId].flowRefs.includes(flowId)) {
                appState.itemHierarchy[itemId].flowRefs.push(flowId);
            }
        }
    };

    // Remove flow reference from item
    const removeFlowReference = (itemId, flowId) => {
        if (appState.itemHierarchy[itemId]) {
            const index = appState.itemHierarchy[itemId].flowRefs.indexOf(flowId);
            if (index > -1) {
                appState.itemHierarchy[itemId].flowRefs.splice(index, 1);
            }
        }
    };

    // Notify item update to all referencing flows
    const notifyItemUpdate = (itemId) => {
        const hierarchy = appState.itemHierarchy[itemId];
        if (hierarchy) {
            hierarchy.flowRefs.forEach(flowId => {
                // Trigger re-render for this flow
                if (flowId === appState.currentFlowId) {
                    render();
                }
            });
        }
    };

    // Remove item from all flows
    const removeItemFromAllFlows = (itemId) => {
        const hierarchy = appState.itemHierarchy[itemId];
        if (hierarchy) {
            hierarchy.flowRefs.forEach(flowId => {
                const flow = appState.flows[flowId];
                if (flow) {
                    if (appState.items[itemId]?.type === 'control') {
                        const index = flow.controlRefs.indexOf(itemId);
                        if (index > -1) {
                            flow.controlRefs.splice(index, 1);
                        }
                    } else {
                        // Remove from parent's children
                        const parentId = hierarchy.parentId;
                        if (parentId) {
                            removeChildFromParent(parentId, itemId);
                        }
                    }
                }
            });
        }
    };

    // --- SHARING SYSTEM ---
    
    // Share item to flow (add reference)
    const shareItem = (itemId, targetFlowId, targetParentId = null) => {
        const item = getItem(itemId);
        const targetFlow = appState.flows[targetFlowId];
        
        if (!item || !targetFlow) {
            throw new Error('Item or flow not found');
        }
        
        // Validate parent exists in target flow
        if (targetParentId && !validateParentInFlow(targetParentId, targetFlowId)) {
            throw new Error('Parent not found in target flow');
        }
        
        // Add reference to flow
        if (item.type === 'control') {
            targetFlow.controlRefs.push(itemId);
        } else {
            // Add to parent's children
            addChildToParent(targetParentId, itemId);
        }
        
        // Update item metadata
        updateItem(itemId, { isShared: true });
        
        // Add flow reference
        addFlowReference(itemId, targetFlowId);
        
        // Share children recursively
        const hierarchy = appState.itemHierarchy[itemId];
        if (hierarchy) {
            hierarchy.childRefs.forEach(childId => {
                shareItem(childId, targetFlowId, itemId);
            });
        }
    };

    // Clone item (create new item with same data)
    const cloneItem = (itemId, targetFlowId, targetParentId = null) => {
        const originalItem = getItem(itemId);
        if (!originalItem) {
            throw new Error('Item not found');
        }
        
        // Create new item with same data
        const clonedData = {
            name: originalItem.name,
            text: originalItem.text,
            tags: [...originalItem.tags],
            grade: originalItem.grade,
            footer: JSON.parse(JSON.stringify(originalItem.footer))
        };
        
        const newItem = createItem(originalItem.type, clonedData, targetParentId);
        
        // Set as cloned item
        updateItem(newItem.id, { 
            originalId: itemId,
            isShared: false 
        });
        
        // Clone children recursively
        const hierarchy = appState.itemHierarchy[itemId];
        if (hierarchy) {
            hierarchy.childRefs.forEach(childId => {
                cloneItem(childId, targetFlowId, newItem.id);
            });
        }
        
        return newItem;
    };

    // Validate parent exists in flow
    const validateParentInFlow = (parentId, flowId) => {
        const flow = appState.flows[flowId];
        if (!flow) return false;
        
        // Check if parent is a control in this flow
        if (appState.items[parentId]?.type === 'control') {
            return flow.controlRefs.includes(parentId);
        }
        
        // Check if parent is an action in this flow
        if (appState.items[parentId]?.type === 'action') {
            // Find the control that contains this action
            const parentHierarchy = appState.itemHierarchy[parentId];
            if (parentHierarchy?.parentId) {
                const controlId = parentHierarchy.parentId;
                if (flow.controlRefs.includes(controlId)) {
                    return true;
                }
            }
        }
        
        return false;
    };

    // --- FLOW MANAGEMENT ---
    
    // Create new flow
    const createFlow = (name, sourceFlowId = null, mode = 'empty') => {
        const flowId = generateId('flow');
        const flow = {
            id: flowId,
            name,
            controlRefs: [],
            settings: { enforceSequence: true },
            metadata: {
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
        };
        
        if (mode === 'clone' && sourceFlowId) {
            // Clone all controls from source flow
            const sourceFlow = appState.flows[sourceFlowId];
            sourceFlow.controlRefs.forEach(controlId => {
                const clonedControl = cloneItem(controlId, flowId);
                flow.controlRefs.push(clonedControl.id);
            });
        } else if (mode === 'share' && sourceFlowId) {
            // Share all controls from source flow
            const sourceFlow = appState.flows[sourceFlowId];
            sourceFlow.controlRefs.forEach(controlId => {
                shareItem(controlId, flowId);
            });
        }
        
        appState.flows[flowId] = flow;
        return flow;
    };

    // Get flow data for rendering
    const getFlowData = (flowId) => {
        const flow = appState.flows[flowId];
        if (!flow) return [];
        
        return flow.controlRefs.map(controlId => {
            const control = getItem(controlId);
            return buildItemHierarchy(control);
        });
    };

    // Build complete hierarchy for rendering
    const buildItemHierarchy = (item) => {
        if (!item) return null;
        
        const hierarchy = appState.itemHierarchy[item.id];
        if (!hierarchy) return item;
        
        return {
            ...item,
            subcategories: hierarchy.childRefs.map(childId => {
                const child = getItem(childId);
                return buildItemHierarchy(child);
            })
        };
    };

    // Get current flow
    const getCurrentFlow = () => appState.flows[appState.currentFlowId] || null;

    // --- EXECUTION STATE ---
    
    const setCompleted = (itemId, value) => {
        if (appState.executions[itemId]) {
            appState.executions[itemId].completed = !!value;
            appState.executions[itemId].completedAt = value ? Date.now() : null;
        }
    };

    const getCompleted = (itemId, fallback = false) => {
        const exec = appState.executions[itemId];
        return exec ? exec.completed : fallback;
    };

    // --- THEME / MODE ---
    const applyTheme = (theme) => {
        document.body.classList.toggle('dark-theme', theme === 'dark');
        appState.theme = theme;
        localStorage.setItem('workflowTheme', theme);
        render();
    };
    const toggleTheme = () => applyTheme(appState.theme === 'light' ? 'dark' : 'light');

    // --- MIGRATION SYSTEM ---
    
    const migrateToNewArchitecture = (oldData) => {
        const newState = {
            items: {},
            flows: {},
            itemHierarchy: {},
            executions: {},
            currentFlowId: oldData.workflow.flows[0]?.id || null,
            currentMode: 'execution',
            selectedActionPaths: {},
            expandedTextAreas: new Set(),
            activeTag: null,
            theme: 'light'
        };
        
        // Migrate flows
        oldData.workflow.flows.forEach(flow => {
            newState.flows[flow.id] = {
                id: flow.id,
                name: flow.name,
                controlRefs: [],
                settings: flow.settings || { enforceSequence: true },
                metadata: {
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                }
            };
            
            // Migrate controls
            (flow.data || []).forEach(control => {
                const controlId = migrateItem(control, 'control', newState);
                newState.flows[flow.id].controlRefs.push(controlId);
            });
        });
        
        // Migrate execution data
        Object.keys(oldData.executions.flows).forEach(flowId => {
            const flowExec = oldData.executions.flows[flowId];
            Object.keys(flowExec.completed).forEach(evidenceId => {
                if (newState.executions[evidenceId]) {
                    newState.executions[evidenceId].completed = flowExec.completed[evidenceId];
                }
            });
        });
        
        return newState;
    };

    const migrateItem = (item, type, newState) => {
        const itemId = item.id;
        
        // Create item in registry
        newState.items[itemId] = {
            id: itemId,
            type,
            name: item.name,
            text: item.text || '',
            tags: item.tags || [],
            grade: item.grade,
            footer: item.footer || { links: [], images: [], notes: [], comments: [] },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            isShared: !!item.shareKey,
            shareGroup: item.shareKey
        };
        
        // Create hierarchy entry
        newState.itemHierarchy[itemId] = {
            parentId: null,
            childRefs: [],
            flowRefs: []
        };
        
        // Initialize execution data
        newState.executions[itemId] = {
            completed: false,
            grade: item.grade,
            completedAt: null,
            completedBy: null
        };
        
        // Migrate children
        (item.subcategories || []).forEach(child => {
            const childType = type === 'control' ? 'action' : 'evidence';
            const childId = migrateItem(child, childType, newState);
            
            // Set parent-child relationship
            newState.itemHierarchy[itemId].childRefs.push(childId);
            newState.itemHierarchy[childId].parentId = itemId;
        });
        
        return itemId;
    };

    // --- SERVER IO ---
    async function loadAll() {
        try {
            const [wfRes, exRes] = await Promise.all([
                fetch(`workflow.json?t=${Date.now()}`),
                fetch(`executions.json?t=${Date.now()}`)
            ]);
            if (!wfRes.ok) throw new Error('Failed to load workflow.json');
            const workflowData = await wfRes.json();

            if (exRes.ok) {
                const executionData = await exRes.json();
                
                // Migrate to new architecture
                const migratedState = migrateToNewArchitecture({ 
                    workflow: workflowData, 
                    executions: executionData 
                });
                
                // Merge with current state
                appState = { ...appState, ...migratedState };
            } else {
                // Initialize empty state
                appState.executions = {};
            }

            if (!appState.currentFlowId || !getCurrentFlow()) {
                appState.currentFlowId = Object.keys(appState.flows)[0] || null;
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
            // Convert new architecture back to old format for saving
            const oldFormat = convertToOldFormat();
            
            const res = await fetch('save_workflow.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(oldFormat)
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
            // Convert execution data to old format
            const oldExecutionFormat = convertExecutionToOldFormat();
            
            const res = await fetch('save_executions.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(oldExecutionFormat)
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

    // Convert new architecture to old format for saving
    const convertToOldFormat = () => {
        const flows = Object.values(appState.flows).map(flow => ({
            id: flow.id,
            name: flow.name,
            data: flow.controlRefs.map(controlId => {
                const control = getItem(controlId);
                return convertItemToOldFormat(control);
            })
        }));
        
        return {
            settings: { enforceSequence: true },
            flows
        };
    };

    const convertItemToOldFormat = (item) => {
        const hierarchy = appState.itemHierarchy[item.id];
        const oldItem = {
            id: item.id,
            name: item.name,
            text: item.text,
            tags: item.tags,
            shareKey: item.shareGroup,
            subcategories: hierarchy.childRefs.map(childId => {
                const child = getItem(childId);
                return convertItemToOldFormat(child);
            })
        };
        
        if (item.type === 'evidence') {
            oldItem.grade = item.grade;
            oldItem.completed = appState.executions[item.id]?.completed || false;
            oldItem.footer = item.footer;
            oldItem.isLocked = false;
            oldItem.isActive = false;
        }
        
        return oldItem;
    };

    // Convert execution data to old format
    const convertExecutionToOldFormat = () => {
        const flows = {};
        
        Object.values(appState.flows).forEach(flow => {
            const completed = {};
            
            // Collect all evidence IDs in this flow
            const collectEvidenceIds = (controlId) => {
                const control = getItem(controlId);
                if (!control) return;
                
                const hierarchy = appState.itemHierarchy[controlId];
                hierarchy.childRefs.forEach(actionId => {
                    const action = getItem(actionId);
                    if (!action) return;
                    
                    const actionHierarchy = appState.itemHierarchy[actionId];
                    actionHierarchy.childRefs.forEach(evidenceId => {
                        const exec = appState.executions[evidenceId];
                        if (exec) {
                            completed[evidenceId] = exec.completed;
                        }
                    });
                });
            };
            
            flow.controlRefs.forEach(collectEvidenceIds);
            flows[flow.id] = { completed };
        });
        
        return { flows };
    };

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
    const getAllTags = () => {
        const tagSet = new Set();
        Object.values(appState.items).forEach(item => {
            (item.tags || []).forEach(tag => tagSet.add(tag));
        });
        return Array.from(tagSet).sort();
    };

    const renderTags = (item, path, flow) => {
        ensureTagsArray(item);
        const chips = item.tags.map((t, i) => {
            const actionName = appState.currentMode === 'execution' ? 'filter-by-tag' : 'edit-tag';
            const suffix = appState.currentMode === 'creation'
                ? ` <button class="tag-delete" data-action="delete-tag" data-item-id="${item.id}" data-index="${i}" title="Remove tag">&times;</button>`
                : '';
            return `<span class="tag-item" data-action="${actionName}" data-item-id="${item.id}" data-index="${i}" data-tag="${t}">#${t}${suffix}</span>`;
        }).join('');
        const addInput = appState.currentMode === 'creation'
            ? `<div class="tag-input-container">
                <input class="add-tag-input" data-item-id="${item.id}" placeholder="Add tag and press Enter" list="tag-suggestions-${item.id}">
                <datalist id="tag-suggestions-${item.id}"></datalist>
               </div>`
            : '';
        return `<div class="evidence-tags">${chips}${addInput}</div>`;
    };

    // --- FILTERING ---
    function filterWorkflowByTag(data, tag, basePath = 'data') {
        const filteredControls = [];
        (data || []).forEach((control, ci) => {
            const ctlPath = `${basePath}.${ci}`;

            if (nodeHasTag(control, tag)) {
                const fullActions = (control.subcategories || []).map((act, ai) =>
                    copyActionWithAllEvidencePaths(act, `${ctlPath}.subcategories.${ai}`));
                filteredControls.push({ ...control, _path: ctlPath, subcategories: fullActions });
                return;
            }
            const keptActions = [];
            (control.subcategories || []).forEach((act, ai) => {
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
            if (keptActions.length > 0) filteredControls.push({ ...control, _path: ctlPath, subcategories: keptActions });
        });
        return filteredControls;
    }

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

    // --- RENDERING ---
    const render = () => {
        document.body.className = `${appState.currentMode}-mode ${appState.theme}-theme`;

        // flow select
        flowSelect.innerHTML = Object.values(appState.flows).map(f =>
            `<option value="${f.id}" ${f.id === appState.currentFlowId ? 'selected' : ''}>${f.name}</option>`
        ).join('');
        const currentFlow = getCurrentFlow();
        if (!currentFlow) {
            workflowRoot.innerHTML = `<div class="empty-state">No flows. Create one to get started.</div>`;
            return;
        }

        // top toggles
        modeSwitch.checked = appState.currentMode === 'execution';
        enforceSequenceCheckbox.checked = currentFlow.settings.enforceSequence;

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
        const rawData = getFlowData(currentFlow.id);
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
            const c = getCompleted(ev.id, ev.completed);
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
        const controlOriginal = isFiltered ? getItem(control.id) : control;
        const controlProgress = calculateControlProgress(controlOriginal);

        const el = document.createElement('div');
        el.className = 'control-node';
        el.dataset.path = path;
        el.dataset.itemId = control.id;
        el.innerHTML = `
            <div class="control-header">
              <div class="control-header-top">
                <div class="control-title">${control.name}</div>
                <div class="controls creation-only">
                  <button class="btn-add" title="Add Action" data-action="add-action" data-item-id="${control.id}"><i class="fa-solid fa-plus"></i></button>
                  <button class="btn-edit" title="Edit Control Name" data-action="edit-name" data-item-id="${control.id}"><i class="fa-solid fa-pen"></i></button>
                  <button class="btn-add" title="Clone/Share existing" data-action="import-node" data-item-id="${control.id}" data-level="action"><i class="fa-solid fa-copy"></i></button>
                  <button class="btn-delete" title="Delete Control" data-action="delete-node" data-item-id="${control.id}"><i class="fa-solid fa-trash-can"></i></button>
                </div>
              </div>
              ${renderTags(control, path, flow)}
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
                `${controlPath}.subcategories.${(getItem(control.id).subcategories || []).indexOf(action)}`;
            const isSelected = appState.selectedActionPaths[controlPath] === actionPath;

            const { percent, totalGrade } = calculateActionProgress(getItem(action.id));
            const validationError = totalGrade !== 5.0 && (getItem(action.id).subcategories || []).length > 0
                ? `<div class="validation-error">Grade total is ${totalGrade.toFixed(1)}/5.0</div>` : '';
            const tagsHtml = renderTags(getItem(action.id), actionPath, flow);

            return `
              <div class="action-item ${isSelected ? 'selected' : ''}" data-action="select-action" data-item-id="${action.id}" data-control-path="${controlPath}">
                <div class="action-item-header">
                  <div class="action-name">${action.name}</div>
                  <div class="controls creation-only">
                    <button class="btn-add" title="Add Evidence" data-action="add-evidence" data-item-id="${action.id}"><i class="fa-solid fa-plus"></i></button>
                    <button class="btn-edit" title="Edit Action" data-action="edit-name" data-item-id="${action.id}"><i class="fa-solid fa-pen"></i></button>
                    <button class="btn-add" title="Clone/Share existing" data-action="import-node" data-item-id="${action.id}" data-level="evidence"><i class="fa-solid fa-copy"></i></button>
                    <button class="btn-delete" title="Delete Action" data-action="delete-node" data-item-id="${action.id}"><i class="fa-solid fa-trash-can"></i></button>
                  </div>
                </div>
                <div class="action-text creation-only">${getItem(action.id).text || ''}</div>
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
            const actionId = selectedActionPath.split('.').pop();
            const action = getItem(actionId);
            evidenceItems = (action && action.subcategories) ? action.subcategories : [];
        }

        const itemsHtml = evidenceItems.map(evidence => {
            const evidencePath = isFiltered && evidence._path ? evidence._path :
                selectedActionPath + `.subcategories.${(getItem(selectedActionPath.split('.').pop()).subcategories || []).indexOf(evidence)}`;
            return renderEvidenceNode(getItem(evidence.id), evidencePath);
        }).join('') || `<div class="empty-state">No evidence for this action${appState.activeTag ? ' with this tag' : ''}.</div>`;

        return `<div class="evidence-register-panel"><h3 class="panel-title creation-only"><i class="fa-solid fa-receipt"></i> Evidence</h3>${itemsHtml}</div>`;
    }

    function renderEvidenceNode(item, path) {
        const isDone = getCompleted(item.id, item.completed);
        const containerClasses = ['evidence-node'];
        if (appState.currentMode === 'execution') {
            if (item.isLocked) containerClasses.push('locked');
            if (item.isActive) containerClasses.push('active');
        }
        const gradeOptions = [0.5,1.0,1.5,2.0,2.5,3.0,3.5,4.0,4.5,5.0];
        const gradeSelector = `
            <div class="evidence-grade-selector creation-only">
                <label for="grade-${item.id}">Grade:</label>
                <select id="grade-${item.id}" data-action="change-grade" data-item-id="${item.id}">
                    ${gradeOptions.map(g => `<option value="${g}" ${item.grade === g ? 'selected' : ''}>${g.toFixed(1)}</option>`).join('')}
                </select>
            </div>`;
        let descriptionHtml = '';
        if (appState.currentMode === 'creation') {
            descriptionHtml = `<textarea class="evidence-text-creation" data-action="edit-text" data-item-id="${item.id}" placeholder="Enter description...">${item.text || ''}</textarea>`;
        } else if (item.text) {
            descriptionHtml = `<p class="evidence-text-execution">${item.text}</p>`;
        }
        const tagsHtml = renderTags(item, path, getCurrentFlow());
        const footerControlsHtml = `
            <div class="footer-controls creation-only">
                <button title="Add Link" data-action="add-attachment" data-type="link" data-item-id="${item.id}"><i class="fa-solid fa-link"></i></button>
                <button title="Add Image URL" data-action="add-attachment" data-type="image" data-item-id="${item.id}"><i class="fa-solid fa-image"></i></button>
                <button title="Add Note" data-action="add-attachment" data-type="note" data-item-id="${item.id}"><i class="fa-solid fa-book-open"></i></button>
                <button title="Add Comment" data-action="add-attachment" data-type="comment" data-item-id="${item.id}"><i class="fa-solid fa-comment"></i></button>
            </div>`;
        return `
          <div class="${containerClasses.join(' ')}" data-path="${path}" data-item-id="${item.id}">
            <div class="evidence-header">
              <div class="evidence-title ${isDone ? 'completed' : ''}">
                <input type="checkbox" class="evidence-checkbox execution-only" data-action="toggle-complete" data-item-id="${item.id}" ${isDone ? 'checked' : ''} id="checkbox-${item.id}">
                <label for="checkbox-${item.id}" class="title-label">${item.name}</label>
              </div>
              ${gradeSelector}
              <div class="controls creation-only">
                <button class="btn-manage" title="Manage Attachments" data-action="manage-attachments" data-item-id="${item.id}"><i class="fa-solid fa-gear"></i></button>
                <button class="btn-edit" title="Edit Evidence Name" data-action="edit-name" data-item-id="${item.id}"><i class="fa-solid fa-pen"></i></button>
                <button class="btn-delete" title="Delete Evidence" data-action="delete-node" data-item-id="${item.id}"><i class="fa-solid fa-trash-can"></i></button>
              </div>
            </div>
            ${descriptionHtml}
            ${tagsHtml}
            <div class="evidence-footer">
              <div class="footer-item-list">
                ${(item.footer?.links || []).map((link, i) => `<div class="footer-item" title="${getAbsoluteUrl(link.url)}" data-action="show-link-in-modal" data-item-id="${item.id}" data-index="${i}"><i class="fa-solid fa-link"></i> ${link.text}</div>`).join('')}
                ${(item.footer?.images || []).map((img, i) => `<div class="footer-item" title="View Image" data-action="show-image-in-modal" data-item-id="${item.id}" data-index="${i}"><i class="fa-solid fa-image"></i> Image ${i+1}</div>`).join('')}
                ${(item.footer?.notes || []).map((note, i) => `<div class="footer-item" title="View Note" data-action="show-note-content" data-item-id="${item.id}" data-index="${i}"><i class="fa-solid fa-book-open"></i> ${note.title}</div>`).join('')}
                <span class="execution-only">
                  ${(item.footer?.comments || []).length > 0 ? `<div class="footer-item" data-action="show-view-modal" data-type="comments" data-item-id="${item.id}"><i class="fa-solid fa-comment"></i> Comments (${item.footer.comments.length})</div>` : ''}
                </span>
              </div>
              ${footerControlsHtml}
            </div>
          </div>`;
    }

    // --- EXECUTION LOCKING (sequence) ---
    function updateAllExecutionStates(flow) {
        const enforce = flow.settings?.enforceSequence;
        flow.controlRefs.forEach(controlId => {
            const control = getItem(controlId);
            const hierarchy = appState.itemHierarchy[controlId];
            hierarchy.childRefs.forEach(actionId => {
                const action = getItem(actionId);
                const actionHierarchy = appState.itemHierarchy[actionId];
                let foundFirstIncomplete = false;
                actionHierarchy.childRefs.forEach(evidenceId => {
                    const done = getCompleted(evidenceId);
                    if (!enforce) {
                        // Update item properties for rendering
                        updateItem(evidenceId, { isLocked: false, isActive: false });
                        return;
                    }
                    if (!foundFirstIncomplete && !done) {
                        updateItem(evidenceId, { isLocked: false, isActive: true });
                        foundFirstIncomplete = true;
                    } else {
                        updateItem(evidenceId, { isActive: false, isLocked: foundFirstIncomplete });
                    }
                });
            });
        });
    }

    // --- ATTACHMENTS & VIEWERS ---
    const showLinkModal = (itemId, index) => {
        const item = getItem(itemId);
        const link = item.footer.links[index];
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
    const showViewOnlyModal = (itemId, type) => {
        const item = getItem(itemId);
        const { images = [], comments = [] } = item.footer || {};
        if (type === 'images') {
            openModal(`Images for: ${item.name}`, `<div class="modal-gallery">${images.map(img => `<img class="modal-gallery-image" src="${getAbsoluteUrl(img)}" alt="Workflow Image">`).join('')}</div>`);
        } else if (type === 'comments') {
            openModal(`Comments for: ${item.name}`, `<ul class="modal-list">${comments.map(c => `<li class="modal-item"><span class="modal-item-text">${c}</span></li>`).join('')}</ul>`);
        }
    };

    function renderModalList(items, itemId, type) {
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
                            <button class="btn-edit" title="Edit" data-action="edit-${type}" data-item-id="${itemId}" data-index="${index}"><i class="fa-solid fa-pen"></i></button>
                            <button class="btn-delete" title="Delete" data-action="delete-${type}" data-item-id="${itemId}" data-index="${index}"><i class="fa-solid fa-trash-can"></i></button>
                        </div>
                    </li>`;
            }).join('')
        }</ul>`;
    }
    const showManagementModal = (itemId) => {
        const item = getItem(itemId);
        const { links = [], images = [], notes = [], comments = [] } = item.footer || {};
        const linksHtml = `<div class="modal-section"><h4><i class="fa-solid fa-link"></i> Links</h4>${renderModalList(links, itemId, 'link')}</div>`;
        const imagesHtml = `<div class="modal-section"><h4><i class="fa-solid fa-image"></i> Images</h4>${renderModalList(images, itemId, 'image')}</div>`;
        const notesHtml = `<div class="modal-section"><h4><i class="fa-solid fa-book-open"></i> Notes</h4>${renderModalList(notes, itemId, 'note')}</div>`;
        const commentsHtml = `<div class="modal-section"><h4><i class="fa-solid fa-comment"></i> Comments</h4>${renderModalList(comments, itemId, 'comment')}</div>`;
        openModal(`Manage Attachments for: ${item.name}`, linksHtml + imagesHtml + notesHtml + commentsHtml);
    };
    const showAddAttachmentModal = (itemId, type) => {
        const title = `Add New ${type==='note'?'Note':type[0].toUpperCase()+type.slice(1)}`;
        let formHtml = `<form class="modal-form" data-action="submit-attachment" data-item-id="${itemId}" data-type="${type}">`;
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
        const flowChecks = Object.values(appState.flows).map(f =>
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
                Object.values(appState.flows).filter(f => flowIds.includes(f.id)).forEach(flow => {
                    flow.controlRefs.forEach(controlId => {
                        const control = getItem(controlId);
                        (control.tags || []).forEach(t => set.add(t));
                        const hierarchy = appState.itemHierarchy[controlId];
                        hierarchy.childRefs.forEach(actionId => {
                            const action = getItem(actionId);
                            (action.tags || []).forEach(t => set.add(t));
                            const actionHierarchy = appState.itemHierarchy[actionId];
                            actionHierarchy.childRefs.forEach(evidenceId => {
                                const evidence = getItem(evidenceId);
                                (evidence.tags || []).forEach(t => set.add(t));
                            });
                        });
                    });
                });
                return Array.from(set).sort((a, b) => a.localeCompare(b));
            };

            const refreshDatalist = () => {
                const selectedFlows = Array.from(document.querySelectorAll('.global-flow-check:checked')).map(i => i.value);
                const tags = collectTags(selectedFlows);
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
        const results = new Map();
        const keyFor = (item) => item.id;

        Object.values(appState.flows).filter(f => flowIds.includes(f.id)).forEach(flow => {
            flow.controlRefs.forEach(controlId => {
                const control = getItem(controlId);
                const ctlMatch = tags.length === 0 ? false : (control.tags || []).some(t => tags.includes(t));
                const hierarchy = appState.itemHierarchy[controlId];
                hierarchy.childRefs.forEach(actionId => {
                    const action = getItem(actionId);
                    const actMatch = tags.length === 0 ? false : (action.tags || []).some(t => tags.includes(t)) || ctlMatch;
                    const actionHierarchy = appState.itemHierarchy[actionId];
                    actionHierarchy.childRefs.forEach(evidenceId => {
                        const evidence = getItem(evidenceId);
                        const evMatch = tags.length === 0 ? false : (evidence.tags || []).some(t => tags.includes(t)) || actMatch;
                        if (ctlMatch || actMatch || evMatch) {
                            const node = evMatch ? evidence : (actMatch ? action : control);
                            const k = keyFor(node);
                            const label = evMatch ? `Evidence: ${evidence.name}` : actMatch ? `Action: ${action.name}` : `Control: ${control.name}`;
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
        const itemId = btn.dataset.itemId;
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
        const item = itemId ? getItem(itemId) : null;

        const actions = {
            // ----- STRUCTURE -----
            'add-category': () => {
                const n = prompt("Enter new Control name:");
                if (!n) return;
                const ctl = createItem('control', { name: n, text: '', tags: [] });
                flow.controlRefs.push(ctl.id);
                addFlowReference(ctl.id, flow.id);
                openDistributeNewNodeModal({ node: ctl, level: 'control', flow });
            },
            'add-action': () => {
                const n = prompt("Enter new Action name:");
                if (!n) return;
                const act = createItem('action', { name: n, text: '', tags: [] }, itemId);
                
                // If the parent control is shared, share the new action
                if (item.isShared) {
                    shareNewItemToAllFlows(act.id, itemId);
                }
                
                openDistributeNewNodeModal({ node: act, level: 'action', flow, parentPath: path });
            },
            'add-evidence': () => {
                const n = prompt("Enter new Evidence name:");
                if (!n) return;
                const evi = createItem('evidence', {
                    name: n, text: '', grade: 1.0, tags: [],
                    footer: { links: [], images: [], notes: [], comments: [] }
                }, itemId);
                
                // If the parent action is shared, share the new evidence
                if (item.isShared) {
                    shareNewItemToAllFlows(evi.id, itemId);
                }
                
                openDistributeNewNodeModal({ node: evi, level: 'evidence', flow, parentPath: path });
            },
            'edit-name': () => {
                const n = prompt("Enter new name:", item.name);
                if (n === null) return;
                updateItem(itemId, { name: n });
            },
            'delete-node': () => {
                if (!confirm(`Delete "${item.name}"?`)) return;
                deleteItem(itemId);
            },
            'select-action': () => { appState.selectedActionPaths[controlPath] = path; },

            // ----- IMPORT / CLONE / SHARE (creation only) -----
            'import-node': () => {
                const lvl = btn.dataset.level;
                openImportModal(itemId, lvl);
                shouldRender = false;
            },

            // ----- ATTACHMENTS -----
            'add-attachment': () => { showAddAttachmentModal(itemId, type); shouldRender = false; },
            'manage-attachments': () => { showManagementModal(itemId); shouldRender = false; },
            'show-link-in-modal': () => { showLinkModal(itemId, index); shouldRender = false; },
            'show-image-in-modal': () => { showViewOnlyModal(itemId, 'images'); shouldRender = false; },
            'show-note-content': () => {
                const nNote = item.footer.notes[index];
                openModal(nNote.title, `<div class="note-view-content ql-snow"><div class="ql-editor">${nNote.content}</div></div>`);
                shouldRender = false;
            },
            'show-view-modal': () => {
                const modalType = btn.dataset.type;
                showViewOnlyModal(itemId, modalType);
                shouldRender = false;
            },
            'cancel-modal': () => { closeModal(); shouldRender = false; },

            // ----- TAGS -----
            'delete-tag': () => { 
                const tags = [...item.tags];
                tags.splice(parseInt(index, 10), 1);
                updateItem(itemId, { tags });
            },
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
        const itemId = target.dataset.itemId;
        
        if (action === 'toggle-complete') {
            setCompleted(itemId, t.checked);
            updateAllExecutionStates(flow);
            render();
        } else if (action === 'change-grade') {
            updateItem(itemId, { grade: parseFloat(t.value) });
            appState.executions[itemId].grade = parseFloat(t.value);
            render();
        }
    }

    // text edit (creation)
    document.addEventListener('input', (e) => {
        const ta = e.target.closest('textarea[data-action="edit-text"]');
        if (!ta) return;
        const itemId = ta.dataset.itemId;
        updateItem(itemId, { text: ta.value });
    });

    // tag add (enter) and autocomplete
    document.addEventListener('keydown', (e) => {
        const input = e.target;
        if (input && input.matches('.add-tag-input') && e.key === 'Enter') {
            e.preventDefault();
            const itemId = input.dataset.itemId;
            const item = getItem(itemId);
            const val = (input.value || '').trim();
            if (!val) return;
            const tags = [...item.tags];
            if (!tags.includes(val)) tags.push(val);
            input.value = '';
            updateItem(itemId, { tags });
            render();
        }
    });

    // tag autocomplete
    document.addEventListener('input', (e) => {
        const input = e.target;
        if (input && input.matches('.add-tag-input')) {
            const itemId = input.dataset.itemId;
            const datalistId = `tag-suggestions-${itemId}`;
            const datalist = document.getElementById(datalistId);
            if (datalist) {
                const allTags = getAllTags();
                const currentValue = input.value.toLowerCase();
                const item = getItem(itemId);
                const matchingTags = allTags.filter(tag => 
                    tag.toLowerCase().includes(currentValue) && 
                    !item.tags.includes(tag)
                );
                datalist.innerHTML = matchingTags.map(tag => 
                    `<option value="${tag}"></option>`
                ).join('');
            }
        }
    });

    // attachment forms
    document.addEventListener('submit', (e) => {
        const form = e.target.closest('form[data-action="submit-attachment"]');
        if (!form) return;
        e.preventDefault();
        const itemId = form.dataset.itemId;
        const type = form.dataset.type;
        const item = getItem(itemId);
        
        if (type === 'link') {
            const url = document.getElementById('modal-input-url').value.trim();
            const text = document.getElementById('modal-input-text').value.trim();
            if (url && text) {
                const links = [...item.footer.links, { url, text }];
                updateItem(itemId, { footer: { ...item.footer, links } });
            }
        } else if (type === 'image') {
            const url = document.getElementById('modal-input-url').value.trim();
            if (url) {
                const images = [...item.footer.images, url];
                updateItem(itemId, { footer: { ...item.footer, images } });
            }
        } else if (type === 'comment') {
            const text = document.getElementById('modal-input-text').value.trim();
            if (text) {
                const comments = [...item.footer.comments, text];
                updateItem(itemId, { footer: { ...item.footer, comments } });
            }
        } else if (type === 'note') {
            const title = document.getElementById('modal-input-text').value.trim();
            const content = quillEditor ? quillEditor.root.innerHTML : '';
            const notes = [...item.footer.notes, { title, content }];
            updateItem(itemId, { footer: { ...item.footer, notes } });
        }
        closeModal();
        render();
    });

    // edit/delete inside modal lists
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.modal-item-controls [data-action]');
        if (!btn) return;
        const { action, itemId, index } = btn.dataset;
        const item = getItem(itemId);
        if (!item || !item.footer) return;

        if (action === 'delete-link') {
            const links = [...item.footer.links];
            links.splice(index, 1);
            updateItem(itemId, { footer: { ...item.footer, links } });
        } else if (action === 'delete-image') {
            const images = [...item.footer.images];
            images.splice(index, 1);
            updateItem(itemId, { footer: { ...item.footer, images } });
        } else if (action === 'delete-comment') {
            const comments = [...item.footer.comments];
            comments.splice(index, 1);
            updateItem(itemId, { footer: { ...item.footer, comments } });
        } else if (action === 'delete-note') {
            const notes = [...item.footer.notes];
            notes.splice(index, 1);
            updateItem(itemId, { footer: { ...item.footer, notes } });
        } else if (action === 'edit-link') {
            const links = [...item.footer.links];
            const linkItem = links[index];
            const newUrl = prompt('Edit URL:', linkItem.url);
            const newText = prompt('Edit text:', linkItem.text);
            if (newUrl !== null && newText !== null) { 
                links[index] = { url: newUrl, text: newText };
                updateItem(itemId, { footer: { ...item.footer, links } });
            }
        } else if (action === 'edit-image') {
            const images = [...item.footer.images];
            const newUrl = prompt('Edit image URL:', images[index]);
            if (newUrl !== null) {
                images[index] = newUrl;
                updateItem(itemId, { footer: { ...item.footer, images } });
            }
        } else if (action === 'edit-comment') {
            const comments = [...item.footer.comments];
            const newText = prompt('Edit comment:', comments[index]);
            if (newText !== null) {
                comments[index] = newText;
                updateItem(itemId, { footer: { ...item.footer, comments } });
            }
        } else if (action === 'edit-note') {
            const notes = [...item.footer.notes];
            const note = notes[index];
            openModal('Edit Note', `
              <form class="modal-form" data-action="submit-edit-note" data-item-id="${itemId}" data-index="${index}">
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
        showManagementModal(itemId);
    });

    document.addEventListener('submit', (e) => {
        const form = e.target.closest('form[data-action="submit-edit-note"]');
        if (!form) return;
        e.preventDefault();
        const itemId = form.dataset.itemId;
        const idx = parseInt(form.dataset.index, 10);
        const item = getItem(itemId);
        const title = document.getElementById('modal-input-text').value.trim();
        const content = quillEditor ? quillEditor.root.innerHTML : '';
        const notes = [...item.footer.notes];
        notes[idx] = { title, content };
        updateItem(itemId, { footer: { ...item.footer, notes } });
        closeModal();
        showManagementModal(itemId);
    });

    // --- IMPORT MODAL (clone/share existing nodes at same level into current flow) ---
    function openImportModal(targetItemId, level) {
        const items = [];
        Object.values(appState.flows).forEach(flow => {
            if (level === 'action') {
                flow.controlRefs.forEach(controlId => {
                    const control = getItem(controlId);
                    const hierarchy = appState.itemHierarchy[controlId];
                    hierarchy.childRefs.forEach(actionId => {
                        const action = getItem(actionId);
                        items.push({ flow, level, node: action });
                    });
                });
            } else if (level === 'evidence') {
                flow.controlRefs.forEach(controlId => {
                    const control = getItem(controlId);
                    const hierarchy = appState.itemHierarchy[controlId];
                    hierarchy.childRefs.forEach(actionId => {
                        const action = getItem(actionId);
                        const actionHierarchy = appState.itemHierarchy[actionId];
                        actionHierarchy.childRefs.forEach(evidenceId => {
                            const evidence = getItem(evidenceId);
                            items.push({ flow, level, node: evidence });
                        });
                    });
                });
            }
        });
        const rows = items.map((it, i) => `<option value="${i}">${it.flow.name} • ${it.level === 'action' ? 'Action' : 'Evidence'}: ${it.node.name}</option>`).join('');
        const body = `
            <form id="import-form" class="modal-form">
                <label>Select source ${level === 'action' ? 'Action' : 'Evidence'}</label>
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
        openModal(`Import ${level === 'action' ? 'Action' : 'Evidence'}`, body, () => {
            const form = document.getElementById('import-form');
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                const idx = parseInt(document.getElementById('import-source').value, 10);
                const mode = form.querySelector('input[name="import-mode"]:checked').value;
                const source = items[idx];
                const targetFlow = getCurrentFlow();

                if (level === 'action') {
                    if (mode === 'clone') {
                        const newAction = cloneItem(source.node.id, targetFlow.id, targetItemId);
                    } else {
                        shareItem(source.node.id, targetFlow.id, targetItemId);
                    }
                } else if (level === 'evidence') {
                    if (mode === 'clone') {
                        const newEvidence = cloneItem(source.node.id, targetFlow.id, targetItemId);
                    } else {
                        shareItem(source.node.id, targetFlow.id, targetItemId);
                    }
                }
                closeModal();
                render();
            });
        });
    }

    // --- DISTRIBUTE NEW NODE (copy/share to other flows) ---
    function openDistributeNewNodeModal({ node, level, flow, parentPath }) {
        const otherFlows = Object.values(appState.flows).filter(f => f.id !== flow.id);
        if (otherFlows.length === 0) return;

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

                selected.forEach(fid => {
                    const targetFlow = appState.flows[fid];
                    if (!targetFlow) return;

                    try {
                        if (mode === 'copy') {
                            const clonedItem = cloneItem(node.id, fid);
                            if (level === 'control') {
                                targetFlow.controlRefs.push(clonedItem.id);
                            }
                            result.added.push(`${targetFlow.name}`);
                        } else {
                            shareItem(node.id, fid);
                            result.added.push(`${targetFlow.name}`);
                        }
                    } catch (error) {
                        result.skipped.push(`${targetFlow.name} (${error.message})`);
                    }
                });

                const out = [];
                if (result.added.length) out.push(`<div class="modal-item"><div class="modal-item-text"><strong>Added to:</strong> ${result.added.join(', ')}</div></div>`);
                if (result.skipped.length) out.push(`<div class="modal-item"><div class="modal-item-text"><strong>Skipped:</strong> ${result.skipped.join('; ')}</div></div>`);
                document.getElementById('dist-result').innerHTML = out.join('') || `<div class="empty-state">No target flow selected.</div>`;
            });
        });
    }

    // Share new item to all flows that reference the parent
    function shareNewItemToAllFlows(newItemId, parentId) {
        const parentHierarchy = appState.itemHierarchy[parentId];
        if (parentHierarchy) {
            parentHierarchy.flowRefs.forEach(flowId => {
                if (flowId !== appState.currentFlowId) {
                    try {
                        shareItem(newItemId, flowId, parentId);
                    } catch (error) {
                        console.warn(`Failed to share item ${newItemId} to flow ${flowId}:`, error);
                    }
                }
            });
        }
    }

    // --- FLOW MANAGEMENT (new / clone / share / rename / delete) ---
    function openNewFlowModal() {
        if (appState.currentMode !== 'creation') return;
        const flowsOptions = Object.values(appState.flows).map(f => `<option value="${f.id}">${f.name}</option>`).join('');
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
                
                const newFlow = createFlow(name, srcId, mode);
                appState.currentFlowId = newFlow.id;

                closeModal();
                render();
            });
        });
    }

    function renameCurrentFlow() {
        if (appState.currentMode !== 'creation') return;
        const flow = getCurrentFlow();
        if (!flow) return;
        const n = prompt('Flow name:', flow.name);
        if (n !== null) { 
            flow.name = n;
            render(); 
        }
    }

    function deleteCurrentFlow() {
        if (appState.currentMode !== 'creation') return;
        const flow = getCurrentFlow();
        if (!flow) return;
        if (!confirm(`Delete flow "${flow.name}"?`)) return;
        
        // Remove all items from this flow
        flow.controlRefs.forEach(controlId => {
            removeFlowReference(controlId, flow.id);
        });
        
        delete appState.flows[flow.id];
        appState.currentFlowId = Object.keys(appState.flows)[0] || null;
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
        if (flow) {
            updateAllExecutionStates(flow);
        }
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
        if (appState.currentMode !== 'creation') return;
        const flow = getCurrentFlow();
        if (flow) {
            flow.settings.enforceSequence = enforceSequenceCheckbox.checked;
            updateAllExecutionStates(flow);
            render();
        }
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