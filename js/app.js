import { APP_VERSION, LOCAL_STATE_KEY } from "./config/app-config.js";
import { appDataRef } from "./firebase-client.js";
import { waitForAuthenticatedUser, currentAuthenticatedUser } from "./auth.js";
import {
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

    let firebaseReady = false;
    let cloudListening = false;
    let applyingRemoteState = false;
    let pendingCloudSave = null;
    let lastCloudPayload = "";


    const today = () => new Date().toISOString().slice(0,10);
    const monthNow = () => new Date().toISOString().slice(0,7);
    const uid = (prefix='id') => prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
    const money = n => new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(Number(n||0));
    const num = v => Number(v || 0);

    const navItems = [
      {id:'dashboard', icon:'🏠', label:'Inicio', subtitle:'Lote actual y pendientes prioritarios.'},
      {id:'orders', icon:'🛍️', label:'Pedidos', subtitle:'Clientes, pagos y entregas del lote.'},
      {id:'batches', icon:'🧾', label:'Lotes', subtitle:'Abre una venta nueva o consulta el historial.'},
      {id:'recipes', icon:'🧁', label:'Costeo', subtitle:'Compras, cantidades producidas e inversión.'},
      {id:'expenses', icon:'💸', label:'Gastos', subtitle:'Otros gastos relacionados con cada lote.'},
      {id:'products', icon:'🍰', label:'Productos', subtitle:'Precios, costos y productos disponibles.'},
      {id:'accounting', icon:'📊', label:'Reportes', subtitle:'Ventas, cobros, inversión y resultados.'}
    ];

    const guideMeta = {
      batches: {title:'Lotes', text:'Crea una venta nueva o consulta lotes anteriores sin mezclar sus pedidos.'},
      orders: {title:'Pedidos', text:'Registra pedidos y controla pagos y entregas desde una sola lista.'},
      products: {title:'Productos', text:'Mantén actualizados los productos disponibles, su precio y su costo.'},
      recipes: {title:'Costeo', text:'Para operar solo necesitas registrar compras y cantidades producidas; el detalle por dosis es opcional.'},
      expenses: {title:'Gastos', text:'Registra únicamente los gastos adicionales que correspondan al lote.'},
      accounting: {title:'Reportes', text:'Consulta resultados por lote o por mes cuando necesites revisar el negocio.'}
    };

    const mobilePrimaryNav = [
      {id:'dashboard', icon:'🏠', label:'Inicio'},
      {id:'orders', icon:'🛍️', label:'Pedidos'},
      {id:'batches', icon:'🧾', label:'Lotes'},
      {id:'recipes', icon:'🧁', label:'Costeo'},
      {id:'more', icon:'☰', label:'Más'}
    ];

    function openMobileMorePanel(){
      const panel = document.getElementById('mobileMorePanel');
      if(panel){
        panel.classList.add('show');
        panel.setAttribute('aria-hidden','false');
        document.body.classList.add('mobile-more-open');
        setTimeout(()=>{
          const list = document.getElementById('mobileMoreList');
          if(list) list.scrollTop = 0;
        }, 30);
      }
    }

    function closeMobileMorePanel(){
      const panel = document.getElementById('mobileMorePanel');
      if(panel){
        panel.classList.remove('show');
        panel.setAttribute('aria-hidden','true');
        document.body.classList.remove('mobile-more-open');
      }
    }

    function renderMobileNavigation(){
      const bottom = document.getElementById('mobileBottomNav');
      const moreList = document.getElementById('mobileMoreList');
      if(bottom){
        bottom.innerHTML = mobilePrimaryNav.map(item=>`
          <button class="mobile-bottom-btn" data-mobile-view="${item.id}" type="button" aria-label="${item.label}">
            <span class="mi">${item.icon}</span>
            <span>${item.label}</span>
          </button>
        `).join('');
        bottom.onclick = (e)=>{
          const btn = e.target.closest('[data-mobile-view]');
          if(!btn) return;
          const id = btn.dataset.mobileView;
          if(id === 'more') openMobileMorePanel();
          else showView(id);
        };
      }
      if(moreList){
        moreList.innerHTML = navItems.filter(item=>!mobilePrimaryNav.some(x=>x.id===item.id)).map(item=>`
          <button class="mobile-more-item" data-more-view="${item.id}" type="button">
            <span class="nav-icon">${item.icon}</span>
            <span><strong>${item.label}</strong><small>${item.subtitle}</small></span>
            <span>›</span>
          </button>
        `).join('');
        moreList.onclick = (e)=>{
          const btn = e.target.closest('[data-more-view]');
          if(!btn) return;
          showView(btn.dataset.moreView);
          closeMobileMorePanel();
        };
      }
    }

    function updateMobileNavigationState(id){
      document.querySelectorAll('.mobile-bottom-btn').forEach(btn=>{
        const target = btn.dataset.mobileView;
        const active = target === id || (target === 'more' && !mobilePrimaryNav.some(x=>x.id === id));
        btn.classList.toggle('active', active);
      });
      document.querySelectorAll('.mobile-more-item').forEach(btn=>{
        btn.classList.toggle('active', btn.dataset.moreView === id);
      });
    }

    function renderSectionGuide(id){
      const box = document.getElementById('sectionGuide');
      if(!box) return;
      if(id === 'dashboard'){ box.innerHTML = ''; return; }
      const item = navItems.find(x=>x.id===id);
      const guide = guideMeta[id];
      if(!guide){ box.innerHTML=''; return; }
      box.innerHTML = `<details class="section-help"><summary><span>${item?.icon || '✨'}</span> ¿Qué hago aquí?</summary><p>${guide.text}</p></details>`;
    }


    let state = null;

    function defaultState(){
      return {
        activeBatchId:'',
        productionBatch:{name:'', productQuantities:{}},
        productionBatches:{},
        products:[],
        batches:[],
        orders:[],
        expenses:[],
        materials:[],
        recipeItems:[],
        auditLog:[],
        systemMeta:{},
        schemaVersion:3
      };
    }

    function sampleMaterialsAndRecipes(data){
      data.materials = Array.isArray(data.materials) ? data.materials : [];
      data.recipeItems = Array.isArray(data.recipeItems) ? data.recipeItems : [];
    }

    function normalizeState(data){
      data.products ||= [];
      data.batches ||= [];
      data.orders ||= [];
      data.expenses ||= [];
      if(!Array.isArray(data.materials) || !Array.isArray(data.recipeItems)) sampleMaterialsAndRecipes(data);
      data.materials ||= [];
      data.recipeItems ||= [];
      data.productionBatches ||= {};
      data.productionBatch ||= {name:'Tanda actual', productQuantities:{}};
      data.productionBatch.productQuantities ||= {};
      data.auditLog = Array.isArray(data.auditLog) ? data.auditLog : [];
      data.systemMeta = data.systemMeta && typeof data.systemMeta === 'object' ? data.systemMeta : {};
      data.systemMeta.lastCompatibleVersion = APP_VERSION;
      data.schemaVersion = Math.max(num(data.schemaVersion || 0), 3);
      data.batches = data.batches.map(batch => {
        const b = batch && typeof batch === 'object' ? batch : {};
        b.archived = b.archived === true;
        b.closureHistory = Array.isArray(b.closureHistory) ? b.closureHistory : [];
        if(b.status === 'cerrado' && !b.closedAt) b.closedAt = b.updatedAt || b.deliveryDate || b.openDate || '';
        return b;
      });
      data.orders = data.orders.map(order => {
        const o = order && typeof order === 'object' ? order : {};
        o.paid = Math.max(0, Math.min(num(o.paid), num(o.total)));
        o.paymentHistory = Array.isArray(o.paymentHistory) ? o.paymentHistory : [];
        o.paymentLocked = o.paymentLocked === true || (num(o.total) > 0 && o.paid >= num(o.total));
        if(o.paymentLocked && !o.paidAt) o.paidAt = o.createdAt || '';
        return o;
      });
      const legacyBatchId = data.productionBatch.batchId || data.activeBatchId || data.batches?.[0]?.id || 'general';
      if(data.productionBatch && !data.productionBatches[legacyBatchId]){
        data.productionBatches[legacyBatchId] = data.productionBatch;
        data.productionBatches[legacyBatchId].batchId = legacyBatchId;
      }
      return data;
    }

    function loadState(){
      try{
        // Si existe una copia legacy en localStorage, se migra después de autenticar.
        let raw = sessionStorage.getItem(LOCAL_STATE_KEY);
        if(!raw){
          raw = localStorage.getItem(LOCAL_STATE_KEY);
          if(raw) localStorage.removeItem(LOCAL_STATE_KEY);
        }
        return normalizeState(raw ? JSON.parse(raw) : defaultState());
      }catch(e){
        return normalizeState(defaultState());
      }
    }
    function persistLocalState(data=state){
      try{
        sessionStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(data));
        return true;
      }catch(error){
        updateCloudStatus('Guardando cambios…', 'saving');
        return false;
      }
    }

    function save(){
      const normalized = normalizeState(state);
      state = normalized;
      persistLocalState(state);
      queueCloudSave();
    }

    function updateCloudStatus(text, mode='sync'){
      const el = document.getElementById('cloudStatus');
      if(!el) return;
      el.textContent = text;
      el.className = `cloud-status ${mode}`;
    }

    function cleanStateForCloud(data){
      const copy = normalizeState(JSON.parse(JSON.stringify(data || defaultState())));
      delete copy.__updatedAt;
      return copy;
    }

    function queueCloudSave(){
      if(!firebaseReady || applyingRemoteState) return;
      clearTimeout(pendingCloudSave);
      pendingCloudSave = setTimeout(saveStateToCloud, 650);
    }

    async function saveStateToCloud(){
      if(!firebaseReady || applyingRemoteState) return;
      const payload = cleanStateForCloud(state);
      const serialized = JSON.stringify(payload);
      if(serialized === lastCloudPayload) return;

      updateCloudStatus('Guardando en la nube…', 'saving');
      try{
        await setDoc(appDataRef, {
          state: payload,
          updatedAt: serverTimestamp(),
          deviceUpdatedAt: new Date().toISOString(),
          updatedBy: currentAuthenticatedUser()?.email || ''
        }, { merge:true });
        lastCloudPayload = serialized;
        updateCloudStatus('Sincronizado en la nube', 'ok');
      }catch(error){
        updateCloudStatus('Sin conexión a la nube. Guardado local.', 'error');
      }
    }

    async function startCloudSync(){
      updateCloudStatus('Sincronizando datos…', 'sync');

      try{
        const snap = await getDoc(appDataRef);
        if(snap.exists() && snap.data()?.state){
          applyingRemoteState = true;
          state = normalizeState(snap.data().state);
          persistLocalState(state);
          lastCloudPayload = JSON.stringify(cleanStateForCloud(state));
          renderAll();
          applyingRemoteState = false;
          updateCloudStatus('Datos actualizados', 'ok');
        }else{
          await setDoc(appDataRef, {
            state: cleanStateForCloud(state),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            deviceUpdatedAt: new Date().toISOString(),
          updatedBy: currentAuthenticatedUser()?.email || ''
          }, { merge:true });
          lastCloudPayload = JSON.stringify(cleanStateForCloud(state));
          updateCloudStatus('Listo para empezar', 'ok');
        }
      }catch(error){
        updateCloudStatus('Sin conexión. Revisa tu internet.', 'error');
      }

      if(cloudListening) return;
      cloudListening = true;

      onSnapshot(appDataRef, (snapshot)=>{
        if(!snapshot.exists() || !snapshot.data()?.state) return;

        const incoming = normalizeState(snapshot.data().state);
        const incomingPayload = JSON.stringify(cleanStateForCloud(incoming));

        if(incomingPayload === lastCloudPayload) return;

        applyingRemoteState = true;
        state = incoming;
        persistLocalState(state);
        lastCloudPayload = incomingPayload;
        renderAll();
        applyingRemoteState = false;
        updateCloudStatus('Sincronizado', 'ok');
      }, (error)=>{
        updateCloudStatus('Conexión interrumpida', 'error');
      });
    }
    function toast(msg){
      const el = document.getElementById('toast');
      el.textContent = msg; el.classList.add('show');
      setTimeout(()=>el.classList.remove('show'), 2600);
    }

    function openModal(id){
      closeModals();
      const modal = document.getElementById(id);
      if(modal) modal.classList.add('show');
    }
    function closeModals(){
      document.querySelectorAll('.modal-backdrop').forEach(m=>m.classList.remove('show'));
    }
    function backdropClose(event){
      if(event.target.classList.contains('modal-backdrop')) closeModals();
    }
    document.addEventListener('keydown', e=>{ if(e.key === 'Escape') closeModals(); });

    function recipeBuilderDefaultRow(){
      return {materialId:'', recipeId:'', name:'', category:'Ingredientes', packageQty:'', unit:'g', packageCost:'', qtyPerUnit:'', notes:''};
    }

    function openRecipeBuilderModal(productId){
      fillSelects();
      const select = document.getElementById('recipeBuilderProduct');
      const modal = document.getElementById('recipeBuilderModal');
      if(!modal){
        alert('No se encontró el modal de receta. Actualiza el archivo del sistema.');
        return;
      }
      if(!state.products.length){
        toast('Primero crea un producto para poder registrar su receta.');
        showView('products');
        return;
      }
      if(!select) return;
      select.innerHTML = state.products.map(p=>`<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('');
      select.value = productId || document.getElementById('recipeProductSelect')?.value || state.products[0]?.id || '';
      document.getElementById('recipeBuilderQty').value = document.getElementById('simQty')?.value || 20;
      loadRecipeBuilderRows();
      openModal('recipeBuilderModal');
    }

    function loadRecipeBuilderRows(){
      const productId = document.getElementById('recipeBuilderProduct')?.value || '';
      const rows = recipeItemsForProduct(productId).map(r=>{
        const m = materialById(r.materialId);
        return {
          materialId:r.materialId, recipeId:r.id, name:m?.name || '', category:m?.category || 'Ingredientes',
          packageQty:m?.packageQty || '', unit:m?.unit || 'g', packageCost:m?.packageCost || '',
          qtyPerUnit:r.qtyPerUnit || '', notes:r.notes || m?.notes || ''
        };
      });
      renderRecipeBuilderRows(rows.length ? rows : [recipeBuilderDefaultRow()]);
      recalcRecipeBuilder();
    }

    function getRecipeBuilderRowsFromDOM(){
      return Array.from(document.querySelectorAll('#recipeBuilderRows .recipe-builder-row')).map(row=>({
        materialId:row.dataset.materialId || '',
        recipeId:row.dataset.recipeId || '',
        name:row.querySelector('[data-field="name"]')?.value.trim() || '',
        category:row.querySelector('[data-field="category"]')?.value || 'Ingredientes',
        packageQty:num(row.querySelector('[data-field="packageQty"]')?.value),
        unit:row.querySelector('[data-field="unit"]')?.value || 'g',
        packageCost:num(row.querySelector('[data-field="packageCost"]')?.value),
        qtyPerUnit:num(row.querySelector('[data-field="qtyPerUnit"]')?.value),
        notes:row.querySelector('[data-field="notes"]')?.value.trim() || ''
      }));
    }

    function renderRecipeBuilderRows(rows){
      const box = document.getElementById('recipeBuilderRows');
      if(!box) return;
      box.innerHTML = rows.map((r,i)=>{
        const hasMeasure = num(r.qtyPerUnit)>0;
        return `
        <div class="recipe-builder-row ${hasMeasure ? 'ready-measure' : 'pending-measure'}" data-index="${i}" data-material-id="${escapeHTML(r.materialId||'')}" data-recipe-id="${escapeHTML(r.recipeId||'')}">
          <div class="row-group">
            <label>Ingrediente comprado
              <input data-field="name" value="${escapeHTML(r.name||'')}" placeholder="Ej: Galleta, crema, empaque" />
            </label>
            <label>Categoría
              <select data-field="category">
                ${['Ingredientes','Empaques','Decoración','Desechables','Otros'].map(c=>`<option ${String(r.category||'Ingredientes')===c?'selected':''}>${c}</option>`).join('')}
              </select>
            </label>
          </div>

          <div class="row-group">
            <div class="row-inline">
              <label>Cantidad comprada
                <input data-field="packageQty" type="number" min="0" step="0.01" value="${r.packageQty ?? ''}" placeholder="1000" />
              </label>
              <label>Unidad
                <select data-field="unit">
                  ${['g','kg','ml','L','unidad','paquete'].map(u=>`<option value="${u}" ${String(r.unit||'g')===u?'selected':''}>${u}</option>`).join('')}
                </select>
              </label>
            </div>
            <label>Precio de compra
              <input data-field="packageCost" type="number" min="0" step="1" value="${r.packageCost ?? ''}" placeholder="15000" />
            </label>
          </div>

          <div class="row-group">
            <label>Medida usada en 1 producto <span class="measure-pending">Opcional ahora</span>
              <input data-field="qtyPerUnit" type="number" min="0" step="0.01" value="${r.qtyPerUnit ?? ''}" placeholder="Déjalo en 0 si no sabes" />
            </label>
            <div class="measurement-helper">Cuando tengas esta medida, el sistema calculará el costo real por unidad.</div>
            <label>Nota
              <input data-field="notes" value="${escapeHTML(r.notes||'')}" placeholder="Opcional" />
            </label>
          </div>

          <div class="recipe-builder-cost-preview" data-cost-preview>
            <small>Estado</small>
            <strong>${hasMeasure ? 'Con medida' : 'Pendiente'}</strong>
            <span class="mini">Completa cuando tengas datos</span>
          </div>

          <button type="button" class="danger recipe-builder-remove" onclick="removeRecipeBuilderRow(${i})">×</button>
        </div>`;
      }).join('');
      recalcRecipeBuilder();
    }

    function addRecipeBuilderRow(){
      const rows = getRecipeBuilderRowsFromDOM();
      rows.push(recipeBuilderDefaultRow());
      renderRecipeBuilderRows(rows);
    }

    function removeRecipeBuilderRow(index){
      const rows = getRecipeBuilderRowsFromDOM();
      rows.splice(index, 1);
      renderRecipeBuilderRows(rows.length ? rows : [recipeBuilderDefaultRow()]);
    }

    function recalcRecipeBuilder(){
      const rows = getRecipeBuilderRowsFromDOM();
      const product = productById(document.getElementById('recipeBuilderProduct')?.value);
      const simQty = Math.max(1, num(document.getElementById('recipeBuilderQty')?.value || 20));
      let unitCost = 0;
      let pending = 0;
      let measured = 0;

      document.querySelectorAll('#recipeBuilderRows .recipe-builder-row').forEach((row, i)=>{
        const r = rows[i] || {};
        const unitMaterialCost = r.packageQty > 0 ? r.packageCost / r.packageQty : 0;
        const hasMeasure = r.qtyPerUnit > 0;
        const ingredientCost = hasMeasure ? unitMaterialCost * r.qtyPerUnit : 0;
        if(hasMeasure){
          unitCost += ingredientCost;
          measured++;
        }else if(r.name || r.packageQty || r.packageCost){
          pending++;
        }
        row.classList.toggle('ready-measure', hasMeasure);
        row.classList.toggle('pending-measure', !hasMeasure);
        const preview = row.querySelector('[data-cost-preview]');
        if(preview){
          preview.innerHTML = hasMeasure
            ? `<small>Costo en receta</small><strong>${money(ingredientCost)}</strong><span class="mini">${money(unitMaterialCost)}/${escapeHTML(r.unit || '')}</span>`
            : `<small>Medida pendiente</small><strong>No calcula aún</strong><span class="mini">${r.packageQty > 0 ? money(unitMaterialCost)+'/'+escapeHTML(r.unit || '') : 'Completa compra'}</span>`;
        }
      });

      const sales = product ? num(product.price) * simQty : 0;
      const investment = unitCost * simQty;
      const profit = sales - investment;
      const complete = pending === 0 && rows.some(r=>r.name);

      document.getElementById('recipeBuilderTotals').innerHTML = [
        ['Ingredientes con medida', String(measured)],
        ['Pendientes', String(pending)],
        ['Costo unitario parcial', money(unitCost)],
        [complete ? `Inversión ${simQty} und.` : 'Inversión final', complete ? money(investment) : 'Pendiente']
      ].map(x=>`<div class="recipe-builder-total-card"><small>${x[0]}</small><strong>${x[1]}</strong></div>`).join('') +
      (complete ? `<div class="recipe-builder-total-card"><small>Ganancia estimada</small><strong>${money(profit)}</strong></div>` : '');
    }

    function saveRecipeBuilder(){
      const productId = document.getElementById('recipeBuilderProduct')?.value;
      const product = productById(productId);
      if(!product){ toast('Selecciona un producto.'); return; }

      const rows = getRecipeBuilderRowsFromDOM().filter(r=>r.name && r.packageQty > 0 && r.packageCost >= 0);
      if(!rows.length){
        toast('Agrega por lo menos un ingrediente con cantidad comprada y costo.');
        return;
      }

      const savedRecipeItems = [];

      rows.forEach(r=>{
        let material = r.materialId ? materialById(r.materialId) : null;
        if(!material){
          material = state.materials.find(m =>
            String(m.name||'').trim().toLowerCase() === r.name.toLowerCase() &&
            String(m.unit||'') === String(r.unit||'')
          );
        }
        if(!material){
          material = {id:uid('mat')};
          state.materials.push(material);
        }

        Object.assign(material, {
          name:r.name,
          category:r.category || 'Ingredientes',
          packageQty:Math.max(0, r.packageQty),
          unit:r.unit || 'g',
          packageCost:Math.max(0, r.packageCost),
          supplier:'',
          updatedAt:today(),
          notes:r.notes || ''
        });

        savedRecipeItems.push({
          id:r.recipeId || uid('rec'),
          productId,
          materialId:material.id,
          qtyPerUnit:Math.max(0, r.qtyPerUnit || 0),
          notes:r.notes || ''
        });
      });

      state.recipeItems = state.recipeItems.filter(item => item.productId !== productId).concat(savedRecipeItems);

      const pendingMeasures = savedRecipeItems.filter(r=>num(r.qtyPerUnit)<=0).length;
      if(pendingMeasures === 0){
        const newCost = recipeCost(productId);
        product.cost = Math.round(newCost);
        toast('Receta completa guardada y costo unitario actualizado.');
      }else{
        toast('Ingredientes guardados. Cuando tengas las medidas, podrás calcular la inversión.');
      }

      document.getElementById('recipeProductSelect').value = productId;
      document.getElementById('simQty').value = document.getElementById('recipeBuilderQty').value || 20;

      closeModals();
      renderAll();
    }

    function openBatchModal(){
      batchForm.reset();
      batchOpen.value=today(); batchDelivery.value=today(); batchStatus.value='abierto';
      openModal('batchModal');
      setTimeout(()=>batchName.focus(), 80);
    }
    function openProductModal(){
      resetProductForm();
      document.getElementById('productModalTitle').textContent = 'Nuevo producto';
      openModal('productModal');
      setTimeout(()=>productName.focus(), 80);
    }
    function openOrderModal(){
      const b=activeBatch(); if(!b){alert('No hay un lote abierto para registrar pedidos. Crea uno o reabre un lote.');return;} if(!batchIsWritable(b.id,'registrar pedidos'))return;
      resetOrderForm();
      document.getElementById('orderModalTitle').textContent = 'Registrar pedido';
      openModal('orderModal');
      setTimeout(()=>orderClient.focus(), 80);
    }
    function openExpenseModal(){
      const b=activeBatch(); if(!b){alert('No hay un lote abierto para registrar gastos. Crea uno o reabre un lote.');return;} if(!batchIsWritable(b.id,'registrar gastos'))return;
      resetExpenseForm();
      document.getElementById('expenseModalTitle').textContent = 'Registrar gasto o inversión';
      openModal('expenseModal');
      setTimeout(()=>expenseConcept.focus(), 80);
    }
    function openMaterialModal(){
      resetMaterialForm();
      document.getElementById('materialModalTitle').textContent = 'Registrar material o insumo';
      openModal('materialModal');
      setTimeout(()=>materialName.focus(), 80);
    }
    function openRecipeModal(){
      resetRecipeForm();
      document.getElementById('recipeModalTitle').textContent = 'Agregar ingrediente a receta';
      openModal('recipeModal');
      setTimeout(()=>recipeQtyPerUnit.focus(), 80);
    }

    function setupNav(){
      const nav = document.getElementById('nav');
      const mobile = document.getElementById('mobileNav');
      nav.innerHTML = navItems.map((item,i)=>`<button class="nav-btn ${i===0?'active':''}" data-view="${item.id}" title="${item.label}"><span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span><span class="nav-arrow">›</span></button>`).join('');
      mobile.innerHTML = navItems.map(item=>`<option value="${item.id}">${item.label}</option>`).join('');
      nav.addEventListener('click', e=>{
        const btn = e.target.closest('[data-view]');
        if(btn) showView(btn.dataset.view);
      });
      mobile.addEventListener('change', e=>showView(e.target.value));
      renderMobileNavigation();
    }

    function showView(id){
      document.body.dataset.view = id;
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===id));
      document.getElementById('mobileNav').value = id;
      const item = navItems.find(x=>x.id===id);
      document.getElementById('pageTitle').textContent = item.label;
      document.getElementById('pageSubtitle').textContent = item.subtitle;
      renderSectionGuide(id);
      updateMobileNavigationState(id);
      closeMobileMorePanel();
      if(id === 'orders') resetOrderFiltersToCurrentBatch();
      renderAll();
      if(window.matchMedia && window.matchMedia('(max-width: 760px)').matches){
        window.scrollTo({top:0, behavior:'smooth'});
      }
    }

    function statusPill(value, type='batch'){
      const labels = {
        abierto:'Abierto', preparacion:'En preparación', entregado:'Entregado', cerrado:'Cerrado',
        pagado:'Pagado', abono:'Abono', pendiente:'Pendiente', activo:'Activo', inactivo:'Inactivo'
      };
      let cls = 'gray';
      if(['pagado','entregado','activo'].includes(value)) cls='ok';
      if(['abono','preparacion','abierto'].includes(value)) cls='warn';
      if(['pendiente','cerrado','inactivo'].includes(value)) cls = value==='cerrado'?'gray':'danger';
      return `<span class="pill ${cls}">${labels[value] || value}</span>`;
    }

    function paymentStatus(order){
      if(num(order.paid) >= num(order.total)) return 'pagado';
      if(num(order.paid) > 0) return 'abono';
      return 'pendiente';
    }
    function saldo(order){ return Math.max(0, num(order.total)-num(order.paid)); }
    function paymentHistory(order){ return Array.isArray(order?.paymentHistory) ? order.paymentHistory : []; }
    function isPaymentLocked(order){ return order?.paymentLocked === true || (num(order?.total)>0 && num(order?.paid)>=num(order?.total)); }
    function paymentChecklistState(order){
      if(isPaymentLocked(order) || saldo(order)<=0) return 'paid';
      if(num(order?.paid)>0) return 'partial';
      return 'pending';
    }
    function paymentCheckControl(order){
      const stateValue = paymentChecklistState(order);
      if(stateValue === 'paid'){
        return `<button class="payment-check-control checked" type="button" disabled title="Pago confirmado y bloqueado"><span class="box">✓</span><span>Pagado</span></button>`;
      }
      if(stateValue === 'partial'){
        return `<button class="payment-check-control partial" type="button" onclick="markOrderPaidFromChecklist('${order.id}')" title="Tiene abonos: completa el saldo antes de marcar pago total"><span class="box"></span><span>Pago parcial</span></button>`;
      }
      return `<button class="payment-check-control" type="button" onclick="markOrderPaidFromChecklist('${order.id}')" title="Marcar como pagado en su totalidad"><span class="box"></span><span>Marcar pagado</span></button>`;
    }
    function normalizePhoneForWhatsapp(phone){
      let clean = String(phone || '').replace(/\D/g,'');
      if(!clean) return '';
      if(clean.startsWith('00')) clean = clean.slice(2);
      if(clean.length === 10 && clean.startsWith('3')) clean = '57' + clean;
      if(clean.length === 11 && clean.startsWith('0')) clean = '57' + clean.slice(1);
      return clean;
    }
    function paymentReminderMessage(order){
      const b = batchById(order.batchId);
      const batchCode = b ? b.code : 'tu pedido';
      const abono = num(order.paid) > 0 ? money(order.paid) : 'Sin abono registrado';
      return `Hola ${order.client} 😊
Te saludamos de Dulce Antojo Postres 🍰
Queríamos recordarte con mucho cariño que tienes un saldo pendiente de tu pedido.

📌 Detalles del pedido:
Lote: ${batchCode}
Producto: ${order.productName}
Cantidad: ${order.quantity}
Valor total: ${money(order.total)}
Abono registrado: ${abono}
Saldo pendiente: ${money(saldo(order))}

Puedes realizar el pago cuando te sea posible y enviarnos el comprobante por este mismo medio.

Si ya realizaste el pago, por favor ignora este mensaje y compártenos el soporte para actualizar tu pedido.

Muchas gracias por tu compra y por apoyar nuestro emprendimiento. 💛`;
    }
    function reminderButton(order){
      const disabled = saldo(order) <= 0 ? 'disabled title="Este pedido ya aparece como pagado"' : '';
      return `<button class="whatsapp" ${disabled} onclick="sendPaymentReminder('${order.id}')">Recordatorio</button>`;
    }
    function batchById(id){ return state.batches.find(b=>b.id===id); }
    function productById(id){ return state.products.find(p=>p.id===id); }
    function materialById(id){ return state.materials.find(m=>m.id===id); }
    function isBatchArchived(batch){ return batch?.archived === true; }
    function isBatchClosed(batch){ return batch?.status === 'cerrado'; }
    function writableBatches(){ return state.batches.filter(b=>!isBatchArchived(b) && !isBatchClosed(b)); }
    function activeBatch(){ const selected=batchById(state.activeBatchId); if(selected && !isBatchArchived(selected) && !isBatchClosed(selected)) return selected; return writableBatches()[0] || null; }
    function batchIsWritable(batchId, action='realizar esta acción'){
      const b=batchById(batchId); if(!b){alert('No se encontró el lote seleccionado.');return false;}
      if(isBatchArchived(b)){alert(`El lote ${b.code} está archivado. Restáuralo antes de ${action}.`);return false;}
      if(isBatchClosed(b)){alert(`El lote ${b.code} está cerrado. Reábrelo de forma explícita antes de ${action}.`);return false;}
      return true;
    }
    function addAudit(action, details={}){ state.auditLog=Array.isArray(state.auditLog)?state.auditLog:[]; state.auditLog.push({id:uid('aud'),action,at:new Date().toISOString(),version:APP_VERSION,userEmail:currentAuthenticatedUser()?.email||'',userUid:currentAuthenticatedUser()?.uid||'',...details}); if(state.auditLog.length>500) state.auditLog=state.auditLog.slice(-500); }
    function materialUnitCost(m){ return num(m?.packageQty) > 0 ? num(m.packageCost) / num(m.packageQty) : 0; }
    function recipeItemsForProduct(productId){ return state.recipeItems.filter(r=>r.productId===productId); }
    function recipeCost(productId){ return recipeItemsForProduct(productId).reduce((s,r)=>{ const m=materialById(r.materialId); return s + num(r.qtyPerUnit) * materialUnitCost(m); },0); }
    function effectiveProductCost(product){ const rCost = recipeCost(product?.id); return rCost > 0 ? rCost : num(product?.cost); }
    function marginPct(price, cost){ return num(price) > 0 ? ((num(price)-num(cost))/num(price))*100 : 0; }
    function pct(value){ return `${Number(value||0).toFixed(1)}%`; }

    function nextBatchCode(){
      const max = state.batches.reduce((m,b)=>{
        const n = Number(String(b.code||'').replace(/\D/g,''));
        return Math.max(m, n || 0);
      },0)+1;
      return 'LOTE-' + String(max).padStart(3,'0');
    }

    function ordersForBatch(batchId){ return state.orders.filter(o=>o.batchId===batchId); }
    function expensesForBatch(batchId){ return state.expenses.filter(e=>e.batchId===batchId); }
    function orderCost(order){ return num(order.unitCost) * num(order.quantity); }
    function summarize(orders, expenses){
      const totalSold = orders.reduce((s,o)=>s+num(o.total),0);
      const totalReceived = orders.reduce((s,o)=>s+Math.min(num(o.paid), num(o.total)),0);
      const totalPending = Math.max(0,totalSold-totalReceived);
      const productCost = orders.reduce((s,o)=>s+orderCost(o),0);
      const extraExpenses = expenses.reduce((s,e)=>s+num(e.amount),0);

      // Evita duplicar costos: si hay gastos/inversión registrados, esos son la inversión real.
      // Si aún no hay gastos, usa el costo unitario de productos solo como estimación.
      const investment = extraExpenses > 0 ? extraExpenses : productCost;
      const investmentMode = extraExpenses > 0 ? 'gastos' : 'costo_productos';

      const estimatedProfit = totalSold - investment;
      const realProfit = totalReceived - investment;
      const units = orders.reduce((s,o)=>s+num(o.quantity),0);
      return {totalSold,totalReceived,totalPending,productCost,extraExpenses,investment,estimatedProfit,realProfit,units,investmentMode};
    }
    function paymentMethodsSummary(orders){
      const map=new Map();
      orders.forEach(order=>{
        const history=paymentHistory(order), historicalTotal=history.reduce((sum,p)=>sum+Math.max(0,num(p.amount)),0);
        history.forEach(p=>{const method=String(p.method||'Otro').trim()||'Otro';const cur=map.get(method)||{method,total:0,count:0};cur.total+=Math.max(0,num(p.amount));cur.count+=1;map.set(method,cur);});
        const legacy=Math.max(0,Math.min(num(order.paid),num(order.total))-historicalTotal);
        if(legacy>0){const method='Histórico sin detalle';const cur=map.get(method)||{method,total:0,count:0};cur.total+=legacy;cur.count+=1;map.set(method,cur);}
      });
      return Array.from(map.values()).sort((a,b)=>b.total-a.total);
    }
    function buildBatchClosureSnapshot(batch){
      const orders=ordersForBatch(batch.id), expenses=expensesForBatch(batch.id), summary=summarize(orders,expenses);
      return {id:uid('cierre'),closedAt:new Date().toISOString(),version:APP_VERSION,orderCount:orders.length,pendingPayments:orders.filter(o=>saldo(o)>0).length,pendingDeliveries:orders.filter(o=>o.deliveryStatus!=='entregado').length,summary:{...summary},paymentMethods:paymentMethodsSummary(orders),note:''};
    }
    function closureSummaryHTML(batch,snapshot,viewingClosed=false){
      const x=snapshot.summary||{}, methods=snapshot.paymentMethods||[];
      const delivery=snapshot.pendingDeliveries>0?`<div class="close-warning"><strong>No se puede cerrar todavía.</strong><br>Hay ${snapshot.pendingDeliveries} pedido${snapshot.pendingDeliveries===1?'':'s'} sin entregar.</div>`:`<div class="close-ok"><strong>Operación lista para cierre.</strong><br>Todos los pedidos están entregados. La cartera pendiente podrá seguir cobrándose después.</div>`;
      const methodRows=methods.length?methods.map(m=>`<div class="summary-row"><span>${escapeHTML(m.method)} <small class="mini">${m.count} movimiento${m.count===1?'':'s'}</small></span><strong>${money(m.total)}</strong></div>`).join(''):'<div class="empty">No hay pagos registrados todavía.</div>';
      const historical=viewingClosed?'<div class="notice"><strong>Fotografía histórica del cierre.</strong> Los abonos posteriores no modifican estos valores.</div>':'';
      return `${historical}<div class="close-summary-grid"><div class="close-summary-card"><small>Pedidos</small><strong>${snapshot.orderCount||0}</strong></div><div class="close-summary-card"><small>Total vendido</small><strong>${money(x.totalSold)}</strong></div><div class="close-summary-card"><small>Recibido al cierre</small><strong>${money(x.totalReceived)}</strong></div><div class="close-summary-card"><small>Cartera pendiente</small><strong>${money(x.totalPending)}</strong></div><div class="close-summary-card"><small>Inversión</small><strong>${money(x.investment)}</strong></div><div class="close-summary-card"><small>Utilidad estimada</small><strong>${money(x.estimatedProfit)}</strong></div></div>${viewingClosed?'':delivery}<div class="card" style="box-shadow:none"><h3 style="margin-top:0">Dinero recibido por método</h3><div class="summary-list">${methodRows}</div></div><div style="height:10px"></div><div class="summary-list"><div class="summary-row"><span>Clientes pendientes de pago</span><strong>${snapshot.pendingPayments||0}</strong></div><div class="summary-row"><span>Pedidos pendientes de entrega</span><strong>${snapshot.pendingDeliveries||0}</strong></div>${snapshot.closedAt?`<div class="summary-row"><span>Fecha del cierre</span><strong>${escapeHTML(String(snapshot.closedAt).replace('T',' ').slice(0,19))}</strong></div>`:''}</div>`;
    }
    function monthFilter(arr, dateKey, month){ return arr.filter(x => String(x[dateKey]||'').slice(0,7) === month); }

    function groupProducts(orders){
      const map = {};
      orders.forEach(o=>{
        const key = o.productId || o.productName;
        if(!map[key]) map[key] = {name:o.productName, qty:0, sold:0, cost:0};
        map[key].qty += num(o.quantity);
        map[key].sold += num(o.total);
        map[key].cost += orderCost(o);
      });
      return Object.values(map).sort((a,b)=>b.qty-a.qty);
    }

    function selectHasValue(el, value){ return Array.from(el.options).some(opt => opt.value === value); }

    function preferredOrderBatchId(){
      const selected = batchById(state.activeBatchId);
      if(selected && !isBatchArchived(selected) && !isBatchClosed(selected)) return selected.id;
      const latestWritable = [...writableBatches()]
        .sort((a,b)=>String(b.createdAt||b.openDate||'').localeCompare(String(a.createdAt||a.openDate||'')))[0];
      if(latestWritable) return latestWritable.id;
      const latestHistorical = [...state.batches]
        .filter(b=>!isBatchArchived(b))
        .sort((a,b)=>String(b.createdAt||b.openDate||'').localeCompare(String(a.createdAt||a.openDate||'')))[0];
      return latestHistorical?.id || '';
    }

    function resetOrderFiltersToCurrentBatch(){
      const el = document.getElementById('filterOrderBatch');
      if(!el) return;
      const preferred = preferredOrderBatchId();
      if(preferred && selectHasValue(el, preferred)) el.value = preferred;
      else if(selectHasValue(el, 'all')) el.value = 'all';
      const payment = document.getElementById('filterPayment');
      const client = document.getElementById('filterClient');
      if(payment) payment.value = 'all';
      if(client) client.value = '';
    }

    function fillSelects(){
      const work=writableBatches();
      const activeOptions=work.map(b=>`<option value="${b.id}">${b.code} - ${b.name}</option>`).join('');
      const reportOptions=state.batches.map(b=>`<option value="${b.id}">${b.code} - ${b.name}${isBatchArchived(b)?' · Archivado':isBatchClosed(b)?' · Cerrado':''}</option>`).join('');
      const allBatchOptions=`<option value="all">Todos los lotes</option>`+reportOptions;
      const orderBatchList=[...state.batches].sort((a,b)=>String(b.createdAt||b.openDate||'').localeCompare(String(a.createdAt||a.openDate||'')));
      const preferredOrderId=preferredOrderBatchId();
      const orderFilterOptions=orderBatchList.map(b=>`<option value="${b.id}">${b.id===preferredOrderId?'Actual · ':''}${b.code} - ${b.name}${isBatchArchived(b)?' · Archivado':isBatchClosed(b)?' · Cerrado':''}</option>`).join('')+`<option value="all">Todos los lotes</option>`;
      const preferredWritable=preferredOrderBatchId();
      const fallback=(batchById(state.activeBatchId)&&work.some(b=>b.id===state.activeBatchId))?state.activeBatchId:(work.some(b=>b.id===preferredWritable)?preferredWritable:(work[0]?.id||''));
      state.activeBatchId=fallback;
      ['activeBatchSelect','orderBatch','expenseBatch'].forEach(id=>{const el=document.getElementById(id);if(!el)return;const prev=el.value;el.innerHTML=activeOptions||'<option value="">Crea o reabre un lote para trabajar</option>';el.value=selectHasValue(el,prev)?prev:fallback;});
      const report=document.getElementById('reportBatch');if(report){const prev=report.value;report.innerHTML=reportOptions||'<option value="">Sin lotes</option>';report.value=selectHasValue(report,prev)?prev:(state.batches[0]?.id||'');}
      const orderFilter=document.getElementById('filterOrderBatch');
      if(orderFilter){const prev=orderFilter.value;orderFilter.innerHTML=orderFilterOptions;orderFilter.value=selectHasValue(orderFilter,prev)?prev:(preferredOrderId||'all');}
      const expenseFilter=document.getElementById('filterExpenseBatch');
      if(expenseFilter){const prev=expenseFilter.value;expenseFilter.innerHTML=allBatchOptions;expenseFilter.value=selectHasValue(expenseFilter,prev)?prev:'all';}
      const productOptions = state.products.filter(p=>p.active).map(p=>`<option value="${p.id}">${p.name} - ${money(p.price)}</option>`).join('');
      const allProductOptions = state.products.map(p=>`<option value="${p.id}">${p.name} - ${money(p.price)}</option>`).join('');
      const productSelect = document.getElementById('orderProduct');
      const prevProduct = productSelect.value;
      productSelect.innerHTML = productOptions || '<option value="">Crea un producto activo</option>';
      if(selectHasValue(productSelect, prevProduct)) productSelect.value = prevProduct;
      ['recipeProductSelect','recipeProduct'].forEach(id=>{
        const el = document.getElementById(id); if(!el) return;
        const prev = el.value;
        el.innerHTML = allProductOptions || '<option value="">Crea un producto primero</option>';
        el.value = selectHasValue(el, prev) ? prev : (state.products[0]?.id || '');
      });
      const materialOptions = state.materials.map(m=>`<option value="${m.id}">${m.name} · ${money(materialUnitCost(m))}/${m.unit}</option>`).join('');
      const matSelect = document.getElementById('recipeMaterial');
      if(matSelect){ const prevMat = matSelect.value; matSelect.innerHTML = materialOptions || '<option value="">Crea un material primero</option>'; if(selectHasValue(matSelect, prevMat)) matSelect.value = prevMat; }
      document.getElementById('reportMonth').value ||= monthNow();
    }

    function renderDashboard(){
      const batch = batchById(state.activeBatchId);
      const metricsBox = document.getElementById('dashboardMetrics');
      const prepareBox = document.getElementById('prepareSummary');
      const tasksBox = document.getElementById('dashboardAlerts');
      const pendingBox = document.getElementById('pendingPreview');
      const financeBox = document.getElementById('dashboardFinancialSummary');

      if(!batch){
        if(metricsBox) metricsBox.innerHTML = '';
        if(prepareBox) prepareBox.innerHTML = '<div class="empty">Crea o reabre un lote para comenzar.</div>';
        if(tasksBox) tasksBox.innerHTML = '<div class="home-task empty-task"><strong>No hay un lote activo</strong><span>Crea un lote para empezar a registrar pedidos.</span><button onclick="openBatchModal()" type="button">Crear lote</button></div>';
        if(pendingBox) pendingBox.innerHTML = '<div class="empty">No hay cobros pendientes.</div>';
        if(financeBox) financeBox.innerHTML = '';
        document.getElementById('pendingCount').textContent = '';
        document.getElementById('activeBatchLabel').textContent = 'Sin lote';
        return;
      }

      const orders = ordersForBatch(batch.id);
      const expenses = expensesForBatch(batch.id);
      const summary = summarize(orders, expenses);
      const products = groupProducts(orders);
      const pending = orders.filter(o=>saldo(o)>0);
      const pendingDeliveries = orders.filter(o=>o.deliveryStatus!=='entregado');
      const paidOrders = orders.filter(o=>paymentStatus(o)==='pagado');

      if(metricsBox){
        metricsBox.innerHTML = [
          {label:'Pedidos', value:String(orders.length), detail:`${summary.units} unidad${summary.units===1?'':'es'}`, tone:'neutral'},
          {label:'Por cobrar', value:money(summary.totalPending), detail:`${pending.length} cliente${pending.length===1?'':'s'}`, tone:pending.length?'warn':'ok'},
          {label:'Por entregar', value:String(pendingDeliveries.length), detail:pendingDeliveries.length?'Requiere seguimiento':'Todo entregado', tone:pendingDeliveries.length?'warn':'ok'}
        ].map(m=>`<div class="home-metric home-metric-${m.tone}"><small>${m.label}</small><strong>${m.value}</strong><span>${m.detail}</span></div>`).join('');
      }

      document.getElementById('activeBatchLabel').innerHTML = `${escapeHTML(batch.code)} · ${statusPill(batch.status)}`;

      if(prepareBox){
        prepareBox.innerHTML = products.length
          ? products.map(p=>`<div class="summary-row"><span>${escapeHTML(p.name)}</span><strong>${p.qty} und.</strong></div>`).join('') + `<div class="summary-row total-line"><span>Total</span><strong>${summary.units} unidades</strong></div>`
          : '<div class="empty">Aún no hay pedidos para preparar.</div>';
      }

      if(tasksBox){
        const tasks=[];
        if(!orders.length){
          tasks.push(`<div class="home-task is-primary"><span class="home-task-icon">🛍️</span><div><strong>Registra el primer pedido</strong><small>Este lote todavía no tiene ventas.</small></div><button onclick="openOrderModal()" type="button">Nuevo pedido</button></div>`);
        }
        if(pending.length){
          tasks.push(`<div class="home-task"><span class="home-task-icon">💳</span><div><strong>${pending.length} cobro${pending.length===1?'':'s'} pendiente${pending.length===1?'':'s'}</strong><small>Faltan ${money(summary.totalPending)} por recibir.</small></div><button class="secondary" onclick="showView('orders')" type="button">Cobrar</button></div>`);
        }
        if(pendingDeliveries.length){
          tasks.push(`<div class="home-task"><span class="home-task-icon">📦</span><div><strong>${pendingDeliveries.length} pedido${pendingDeliveries.length===1?'':'s'} por entregar</strong><small>Revisa la lista antes de cerrar el lote.</small></div><button class="secondary" onclick="showView('orders')" type="button">Revisar</button></div>`);
        }
        if(orders.length && summary.extraExpenses<=0){
          tasks.push(`<div class="home-task"><span class="home-task-icon">💸</span><div><strong>Falta registrar inversión</strong><small>Agrega compras o gastos para calcular el resultado real.</small></div><button class="secondary" onclick="showView('recipes')" type="button">Costear</button></div>`);
        }
        if(!tasks.length){
          tasks.push(`<div class="home-task is-ok"><span class="home-task-icon">✓</span><div><strong>Todo al día</strong><small>No hay cobros ni entregas pendientes en este lote.</small></div></div>`);
        }
        tasksBox.innerHTML=tasks.join('');
      }

      document.getElementById('pendingCount').textContent = pending.length ? `${pending.length} por cobrar` : 'Al día';
      if(pendingBox){
        const visible=pending.slice(0,5);
        pendingBox.innerHTML = visible.length
          ? `<div class="home-pending-list">${visible.map(o=>`<div class="home-pending-item"><button type="button" onclick="openOrderDetail('${o.id}')"><strong>${escapeHTML(o.client)}</strong><small>${escapeHTML(o.productName)} · ${num(o.quantity)} und.</small></button><div><b>${money(saldo(o))}</b><button class="mini-action" onclick="openPaymentModal('${o.id}')" type="button">Abono</button></div></div>`).join('')}</div>${pending.length>5?`<p class="home-more-note">Hay ${pending.length-5} pendiente${pending.length-5===1?'':'s'} más.</p>`:''}`
          : '<div class="empty">No hay saldos pendientes en este lote.</div>';
      }

      if(financeBox){
        financeBox.innerHTML = [
          ['Vendido', money(summary.totalSold)],
          ['Recibido', money(summary.totalReceived)],
          ['Pendiente', money(summary.totalPending)],
          ['Inversión', money(summary.investment)],
          ['Utilidad estimada', money(summary.estimatedProfit)],
          ['Pedidos pagados', String(paidOrders.length)]
        ].map(([label,value])=>`<div><small>${label}</small><strong>${value}</strong></div>`).join('');
      }
    }

    function renderPaymentChecklist(list){
      const priority = {partial:0, pending:1, paid:2};
      const ordered = [...list].sort((a,b)=>{
        const sa = paymentChecklistState(a), sb = paymentChecklistState(b);
        return (priority[sa]-priority[sb]) || String(a.createdAt||'').localeCompare(String(b.createdAt||''));
      });
      return `<div class="payment-checklist">${ordered.map(o=>{
        const stateValue = paymentChecklistState(o);
        const b = batchById(o.batchId);
        const balance = saldo(o);
        const paidText = stateValue==='paid'
          ? `<span class="balance ok">Pago completo</span>`
          : `<span class="balance">Debe ${money(balance)}</span>`;
        const reminder = balance>0 ? reminderButton(o) : '';
        return `<div class="payment-check-item is-${stateValue}">
          <div>
            <button class="payment-client-button" type="button" onclick="openOrderDetail('${o.id}')">${escapeHTML(o.client)}</button>
            <span class="payment-client-meta">${escapeHTML(o.phone||'Sin teléfono')} · ${escapeHTML(b?.code||'Sin lote')} · ${escapeHTML(o.createdAt||'')}</span>
          </div>
          <div class="payment-order-product">
            <strong>${escapeHTML(o.productName)}</strong>
            <small>${num(o.quantity)} und. · Total ${money(o.total)}</small>
          </div>
          <div class="payment-money-summary">
            <span>Abonado <strong>${money(o.paid)}</strong></span>
            ${paidText}
          </div>
          <div class="payment-row-actions">
            ${paymentCheckControl(o)}
            ${balance>0 ? `<button type="button" onclick="openPaymentModal('${o.id}')">+ Abono</button>` : ''}
            ${reminder}
          </div>
        </div>`;
      }).join('')}</div>`;
    }

    function renderOrderMiniTable(list){
      return `<div class="table-wrap action-table"><table><thead><tr><th>Cliente</th><th>Producto</th><th>Cantidad</th><th class="number">Total</th><th class="number">Pagó</th><th class="number">Saldo</th><th>Acciones</th></tr></thead><tbody>${list.map(o=>`<tr><td><button class="payment-client-button" type="button" onclick="openOrderDetail('${o.id}')">${escapeHTML(o.client)}</button><br><small>${escapeHTML(o.phone||'Sin teléfono')}</small></td><td>${escapeHTML(o.productName)}</td><td>${o.quantity}</td><td class="number">${money(o.total)}</td><td class="number">${money(o.paid)}</td><td class="number">${money(saldo(o))}</td><td><div class="row-actions">${saldo(o)>0?`<button onclick="openPaymentModal('${o.id}')">Abono</button>`:''}${reminderButton(o)}</div></td></tr>`).join('')}</tbody></table></div>`;
    }

    function renderBatches(){
      const visible=[...state.batches].sort((a,b)=>Number(isBatchArchived(a))-Number(isBatchArchived(b))||String(b.openDate||'').localeCompare(String(a.openDate||'')));
      const archivedCount=visible.filter(isBatchArchived).length;
      document.getElementById('batchTotal').textContent=`${state.batches.length} lotes · ${archivedCount} archivado${archivedCount===1?'':'s'}`;
      if(!visible.length){document.getElementById('batchTable').innerHTML='<div class="empty">Aún no hay lotes.</div>';return;}
      document.getElementById('batchTable').innerHTML=`<div class="table-wrap action-table"><table><thead><tr><th>Código</th><th>Nombre</th><th>Apertura</th><th>Entrega</th><th>Estado</th><th class="number">Pedidos</th><th class="number">Total vendido</th><th>Acciones</th></tr></thead><tbody>${visible.map(b=>{
        const orders=ordersForBatch(b.id),expenses=expensesForBatch(b.id),sum=summarize(orders,expenses),hasData=orders.length>0||expenses.length>0||state.materials.some(m=>m.batchId===b.id)||Boolean(state.productionBatches?.[b.id]);
        const status=isBatchArchived(b)?'<span class="pill gray">Archivado</span>':statusPill(b.status);
        let actions='';
        if(isBatchArchived(b)) actions=`<button class="secondary" onclick="restoreBatch('${b.id}')">Restaurar</button>`;
        else if(isBatchClosed(b)) actions=`<button class="secondary" onclick="openBatchCloseModal('${b.id}', true)">Ver cierre</button><button onclick="reopenBatch('${b.id}')">Reabrir</button><button class="ghost" onclick="archiveBatch('${b.id}')">Archivar</button>`;
        else actions=`<button class="secondary" onclick="setActiveBatch('${b.id}')">Usar</button><button onclick="changeBatchStatus('${b.id}')">Avanzar</button><button class="ok" onclick="openBatchCloseModal('${b.id}')">Cerrar</button>${hasData?`<button class="ghost" onclick="archiveBatch('${b.id}')">Archivar</button>`:`<button class="danger" onclick="deleteBatch('${b.id}')">Eliminar</button>`}`;
        return `<tr class="${isBatchArchived(b)?'batch-archived-row':''}"><td><strong>${escapeHTML(b.code)}</strong>${state.activeBatchId===b.id?'<br><span class="pill ok">Activo</span>':''}${isBatchClosed(b)?'<br><span class="batch-locked-note">🔒 Operación protegida</span>':''}</td><td>${escapeHTML(b.name)}<br><small>${escapeHTML(b.notes||'')}</small></td><td>${escapeHTML(b.openDate||'')}</td><td>${escapeHTML(b.deliveryDate||'')}</td><td>${status}</td><td class="number">${orders.length}</td><td class="number">${money(sum.totalSold)}</td><td><div class="row-actions">${actions}</div></td></tr>`;
      }).join('')}</tbody></table></div>`;
    }

    function renderProducts(){
      document.getElementById('productTotal').textContent = `${state.products.length} productos`;
      if(!state.products.length){ document.getElementById('productTable').innerHTML = '<div class="empty">Crea tus productos para comenzar.</div>'; return; }
      document.getElementById('productTable').innerHTML = `<div class="table-wrap action-table"><table><thead><tr><th>Producto</th><th class="number">Precio venta</th><th class="number">Costo manual</th><th class="number">Costo por receta</th><th class="number">Margen actual</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${state.products.map(p=>{
        const rCost = recipeCost(p.id);
        const cost = effectiveProductCost(p);
        const margin = num(p.price)-cost;
        return `<tr><td><strong>${escapeHTML(p.name)}</strong><br><small>${rCost>0?'Costo actual tomado de receta':'Costo actual manual'}</small></td><td class="number">${money(p.price)}</td><td class="number">${money(p.cost)}</td><td class="number">${rCost>0?money(rCost):'Sin receta'}</td><td class="number">${money(margin)}<br><small>${pct(marginPct(p.price,cost))}</small></td><td>${statusPill(p.active?'activo':'inactivo')}</td><td><div class="row-actions"><button class="secondary" onclick="editProduct('${p.id}')">Editar</button><button onclick="showRecipeFor('${p.id}')">Receta</button><button class="danger" onclick="deleteProduct('${p.id}')">Eliminar</button></div></td></tr>`;
      }).join('')}</tbody></table></div>`;
    }

    function renderOrders(){
      const batchFilter = document.getElementById('filterOrderBatch').value || 'all';
      const payFilter = document.getElementById('filterPayment').value || 'all';
      const q = (document.getElementById('filterClient').value || '').toLowerCase();
      let orders = [...state.orders].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
      if(batchFilter !== 'all') orders = orders.filter(o=>o.batchId===batchFilter);
      if(payFilter !== 'all') orders = orders.filter(o=>paymentStatus(o)===payFilter);
      if(q) orders = orders.filter(o=>`${o.client} ${o.phone}`.toLowerCase().includes(q));
      document.getElementById('orderTotal').textContent = `${orders.length} pedidos encontrados`;
      if(!orders.length){ document.getElementById('orderTable').innerHTML = '<div class="empty">No hay pedidos con esos filtros.</div>'; return; }
      document.getElementById('orderTable').innerHTML = `<div class="table-wrap action-table"><table><thead><tr><th>Lote</th><th>Cliente</th><th>Producto</th><th class="number">Cant.</th><th class="number">Total</th><th class="number">Pagó</th><th class="number">Saldo</th><th>Pagado</th><th>Entrega</th><th>Acciones</th></tr></thead><tbody>${orders.map(o=>{
        const b = batchById(o.batchId);
        return `<tr><td><strong>${b?b.code:'Sin lote'}</strong><br><small>${o.createdAt||''}</small></td><td><button class="payment-client-button" type="button" onclick="openOrderDetail('${o.id}')">${escapeHTML(o.client)}</button><br><small>${escapeHTML(o.phone||'')}</small></td><td>${escapeHTML(o.productName)}<br><small>${escapeHTML(o.notes||'')}</small></td><td class="number">${o.quantity}</td><td class="number">${money(o.total)}</td><td class="number">${money(o.paid)}</td><td class="number">${money(saldo(o))}</td><td class="order-payment-cell">${paymentCheckControl(o)}</td><td>${statusPill(o.deliveryStatus)}</td><td><div class="row-actions"><button class="secondary" onclick="editOrder('${o.id}')">Editar</button>${saldo(o)>0?`<button class="ok" onclick="openPaymentModal('${o.id}')">Abono</button>`:''}${reminderButton(o)}<button onclick="toggleDelivery('${o.id}')">Entrega</button><button class="danger" onclick="deleteOrder('${o.id}')">Eliminar</button></div></td></tr>`;
      }).join('')}</tbody></table></div>`;
    }

    function renderExpenses(){
      const filter = document.getElementById('filterExpenseBatch').value || 'all';
      let expenses = [...state.expenses].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
      if(filter !== 'all') expenses = expenses.filter(e=>e.batchId===filter);
      document.getElementById('expenseTotal').textContent = `${expenses.length} gastos · ${money(expenses.reduce((s,e)=>s+num(e.amount),0))}`;
      if(!expenses.length){ document.getElementById('expenseTable').innerHTML = '<div class="empty">No hay gastos registrados.</div>'; return; }
      document.getElementById('expenseTable').innerHTML = `<div class="table-wrap action-table"><table><thead><tr><th>Lote</th><th>Fecha</th><th>Concepto</th><th>Categoría</th><th class="number">Valor</th><th>Acciones</th></tr></thead><tbody>${expenses.map(e=>{const b=batchById(e.batchId); return `<tr><td><strong>${b?b.code:'Sin lote'}</strong></td><td>${e.date}</td><td>${escapeHTML(e.concept)}</td><td>${escapeHTML(e.category||'')}</td><td class="number">${money(e.amount)}</td><td><div class="row-actions">${e.source==='productionBatch'?'<button class="secondary" onclick="showView(\'recipes\')">Ver costeo</button><button class="ghost" disabled>Automático</button>':`<button class="secondary" onclick="editExpense('${e.id}')">Editar</button><button class="danger" onclick="deleteExpense('${e.id}')">Eliminar</button>`}</div></td></tr>`}).join('')}</tbody></table></div>`;
    }



    function ensureProductionBatch(){
      const active = activeBatch();
      const batchId = active?.id || 'general';
      state.productionBatches ||= {};
      if(!state.productionBatches[batchId]){
        state.productionBatches[batchId] = {
          batchId,
          name: active ? `Tanda ${active.code}` : 'Tanda actual',
          productQuantities:{},
          materialIds:[],
          expenseId:`gasto_tanda_${batchId}`
        };
      }
      const batch = state.productionBatches[batchId];
      batch.batchId = batchId;
      batch.productQuantities ||= {};
      batch.materialIds ||= [];
      batch.expenseId ||= `gasto_tanda_${batchId}`;

      state.products.forEach(p=>{
        if(batch.productQuantities[p.id] === undefined){
          batch.productQuantities[p.id] = defaultProductionQty(p);
        }
      });

      state.productionBatch = batch;
      return batch;
    }

    function normalizeTextForMatch(text){
      return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    function defaultProductionQty(product){
      const name = normalizeTextForMatch(product?.name);
      if(name.includes('personal') || name.includes('pequen') || name.includes('pequeñ')) return 45;
      if(name.includes('especial') || name.includes('grande')) return 15;
      return 0;
    }

    function isSampleMaterial(m){
      return normalizeTextForMatch(m?.notes).includes('precio de ejemplo');
    }

    function productionMaterials(){
      const batch = ensureProductionBatch();
      const batchMaterials = state.materials.filter(m =>
        num(m.packageCost)>0 &&
        !isSampleMaterial(m) &&
        (m.source === 'productionBatch' || m.isProductionPurchase === true) &&
        m.batchId === batch.batchId
      );

      if(batchMaterials.length) return batchMaterials;

      return state.materials.filter(m =>
        num(m.packageCost)>0 &&
        !isSampleMaterial(m) &&
        !m.batchId &&
        !m.source
      );
    }

    function productionIngredientInvestment(){
      return productionMaterials().reduce((sum,m)=>sum + num(m.packageCost), 0);
    }

    function productionSalesTotal(){
      const batch = ensureProductionBatch();
      return state.products.reduce((sum,p)=>sum + num(batch.productQuantities[p.id]) * num(p.price), 0);
    }

    function productionUnitsTotal(){
      const batch = ensureProductionBatch();
      return state.products.reduce((sum,p)=>sum + num(batch.productQuantities[p.id]), 0);
    }

    function syncProductionInvestmentExpense(){
      const active = activeBatch(); if(!active) return;
      const batch = ensureProductionBatch();

      const investment = productionIngredientInvestment();
      const expenseId = batch.expenseId || `gasto_tanda_${active.id}`;
      batch.expenseId = expenseId;

      const existingIndex = state.expenses.findIndex(e => e.id === expenseId || (e.source === 'productionBatch' && e.batchId === active.id));

      if(investment <= 0){
        if(existingIndex >= 0) state.expenses.splice(existingIndex, 1);
        return;
      }

      const expense = {
        id: expenseId,
        batchId: active.id,
        date: today(),
        concept: `Inversión ingredientes - ${batch.name || active.code}`,
        category: 'Ingredientes',
        amount: investment,
        source: 'productionBatch',
        auto: true,
        notes: 'Generado automáticamente desde Recetas y costeo para evitar duplicar la inversión.'
      };

      if(existingIndex >= 0) state.expenses[existingIndex] = {...state.expenses[existingIndex], ...expense};
      else state.expenses.push(expense);
    }

    function renderProductionBatchCosting(){
      const qtyBox = document.getElementById('productionBatchQuantities');
      const summaryBox = document.getElementById('productionBatchSummary');
      if(!qtyBox || !summaryBox) return;

      const batch = ensureProductionBatch();

      qtyBox.innerHTML = state.products.length ? state.products.map(p=>{
        const qty = num(batch.productQuantities[p.id]);
        return `<div class="production-qty-item">
          <strong>${escapeHTML(p.name)}</strong>
          <small>Precio venta: ${money(p.price)} por unidad</small>
          <input type="number" min="0" step="1" value="${qty}" data-production-product="${p.id}" oninput="updateProductionQty('${p.id}', this.value)" />
        </div>`;
      }).join('') : '<div class="empty">Crea productos para calcular ventas por tanda.</div>';

      renderProductionBatchTotals();
    }

    function renderProductionBatchTotals(){
      const summaryBox = document.getElementById('productionBatchSummary');
      if(!summaryBox) return;
      const batch = ensureProductionBatch();
      const investment = productionIngredientInvestment();
      const sales = productionSalesTotal();
      const units = productionUnitsTotal();
      const profit = sales - investment;
      const materialCount = productionMaterials().length;
      const linkedBatch = activeBatch();

      summaryBox.innerHTML = [
        ['Lote conectado', linkedBatch ? linkedBatch.code : 'Sin lote', 'La inversión se conecta al lote activo'],
        ['Unidades producidas', `${units}`, `${state.products.length} producto${state.products.length===1?'':'s'}`],
        ['Ventas esperadas', money(sales), 'Cantidad producida × precio venta'],
        ['Inversión ingredientes', money(investment), `${materialCount} ingrediente${materialCount===1?'':'s'} comprado${materialCount===1?'':'s'}`],
        ['Ganancia de tanda', money(profit), 'Ventas esperadas - inversión', 'highlight']
      ].map(x=>`<div class="production-summary-card ${x[3]||''}"><small>${x[0]}</small><strong>${x[1]}</strong><span>${x[2]}</span></div>`).join('');
    }

    function updateProductionQty(productId, value){
      const active=activeBatch(); if(!active||!batchIsWritable(active.id,'modificar cantidades producidas'))return;
      const batch = ensureProductionBatch();
      batch.productQuantities[productId] = Math.max(0, num(value));
      save();
      renderProductionBatchTotals();
    }

    function saveProductionQuantitiesFromUI(){
      const active=activeBatch(); if(!active||!batchIsWritable(active.id,'guardar cantidades producidas'))return;
      const batch = ensureProductionBatch();
      document.querySelectorAll('[data-production-product]').forEach(input=>{
        batch.productQuantities[input.dataset.productionProduct] = Math.max(0, num(input.value));
      });
      save();
      renderProductionBatchTotals();
      toast('Cantidades producidas guardadas.');
    }

    function productionPurchaseDefaultRow(){
      return {id:'', name:'', category:'Ingredientes', packageQty:'', unit:'g', packageCost:'', notes:''};
    }

    function openProductionPurchaseModal(){
      const active=activeBatch(); if(!active||!batchIsWritable(active.id,'editar la producción'))return;
      const batch = ensureProductionBatch();
      const nameInput = document.getElementById('productionBatchName');
      if(nameInput) nameInput.value = batch.name || 'Tanda actual';
      const rows = productionMaterials().map(m=>({
        id:m.id,
        name:m.name || '',
        category:m.category || 'Ingredientes',
        packageQty:m.packageQty || '',
        unit:m.unit || 'g',
        packageCost:m.packageCost || '',
        notes:m.notes || ''
      }));
      renderProductionPurchaseRows(rows.length ? rows : [productionPurchaseDefaultRow()]);
      openModal('productionPurchaseModal');
    }

    function getProductionPurchaseRowsFromDOM(){
      return Array.from(document.querySelectorAll('#productionPurchaseRows .production-purchase-row')).map(row=>({
        id:row.dataset.materialId || '',
        name:row.querySelector('[data-field="name"]')?.value.trim() || '',
        category:row.querySelector('[data-field="category"]')?.value || 'Ingredientes',
        packageQty:num(row.querySelector('[data-field="packageQty"]')?.value),
        unit:row.querySelector('[data-field="unit"]')?.value || 'g',
        packageCost:num(row.querySelector('[data-field="packageCost"]')?.value),
        notes:row.querySelector('[data-field="notes"]')?.value.trim() || ''
      }));
    }

    function renderProductionPurchaseRows(rows){
      const box = document.getElementById('productionPurchaseRows');
      if(!box) return;
      box.innerHTML = rows.map((r,i)=>`
        <div class="recipe-builder-row production-purchase-row" data-index="${i}" data-material-id="${escapeHTML(r.id||'')}">
          <div class="row-group">
            <label>Ingrediente comprado
              <input data-field="name" value="${escapeHTML(r.name||'')}" placeholder="Ej: Crema de leche" />
            </label>
            <label>Categoría
              <select data-field="category">
                ${['Ingredientes','Empaques','Decoración','Desechables','Otros'].map(c=>`<option ${String(r.category||'Ingredientes')===c?'selected':''}>${c}</option>`).join('')}
              </select>
            </label>
          </div>

          <div class="row-group">
            <div class="row-inline">
              <label>Cantidad comprada
                <input data-field="packageQty" type="number" min="0" step="0.01" value="${r.packageQty ?? ''}" placeholder="1000" />
              </label>
              <label>Unidad
                <select data-field="unit">
                  ${['g','kg','ml','L','unidad','paquete'].map(u=>`<option value="${u}" ${String(r.unit||'g')===u?'selected':''}>${u}</option>`).join('')}
                </select>
              </label>
            </div>
          </div>

          <div class="row-group">
            <label>Costo total comprado
              <input data-field="packageCost" type="number" min="0" step="1" value="${r.packageCost ?? ''}" placeholder="15000" />
            </label>
          </div>

          <div class="row-group">
            <label>Notas
              <input data-field="notes" value="${escapeHTML(r.notes||'')}" placeholder="Marca, lugar o detalle" />
            </label>
          </div>

          <button type="button" class="danger recipe-builder-remove" onclick="removeProductionPurchaseRow(${i})">×</button>
        </div>
      `).join('');
      recalcProductionPurchase();
    }

    function addProductionPurchaseRow(){
      const rows = getProductionPurchaseRowsFromDOM();
      rows.push(productionPurchaseDefaultRow());
      renderProductionPurchaseRows(rows);
    }

    function removeProductionPurchaseRow(index){
      const rows = getProductionPurchaseRowsFromDOM();
      rows.splice(index, 1);
      renderProductionPurchaseRows(rows.length ? rows : [productionPurchaseDefaultRow()]);
    }

    function recalcProductionPurchase(){
      const rows = getProductionPurchaseRowsFromDOM().filter(r=>r.name && r.packageCost > 0);
      const total = rows.reduce((sum,r)=>sum + num(r.packageCost), 0);
      const qtyTotal = rows.reduce((sum,r)=>sum + num(r.packageQty), 0);
      const box = document.getElementById('productionPurchaseTotals');
      if(!box) return;
      box.innerHTML = [
        ['Ingredientes', `${rows.length}`],
        ['Cantidad total registrada', `${Number(qtyTotal.toFixed(2))}`],
        ['Inversión total', money(total)]
      ].map(x=>`<div class="recipe-builder-total-card"><small>${x[0]}</small><strong>${x[1]}</strong></div>`).join('');
    }

    function saveProductionPurchase(){
      const active=activeBatch(); if(!active||!batchIsWritable(active.id,'guardar compras de producción'))return;
      const batch = ensureProductionBatch();
      const batchName = document.getElementById('productionBatchName')?.value.trim();
      if(batchName) batch.name = batchName;

      const rows = getProductionPurchaseRowsFromDOM().filter(r=>r.name && r.packageQty > 0 && r.packageCost >= 0);
      if(!rows.length){
        toast('Agrega por lo menos un ingrediente comprado con cantidad y costo.');
        return;
      }

      const oldBatchMaterialIds = new Set(productionMaterials().map(m=>m.id));
      const savedMaterials = rows.map(r=>({
        id:r.id || uid('mat'),
        batchId: batch.batchId,
        source:'productionBatch',
        isProductionPurchase:true,
        name:r.name,
        category:r.category || 'Ingredientes',
        packageQty:Math.max(0, r.packageQty),
        unit:r.unit || 'g',
        packageCost:Math.max(0, r.packageCost),
        supplier:'',
        updatedAt:today(),
        notes:r.notes || ''
      }));

      const savedIds = new Set(savedMaterials.map(m=>m.id));
      const deletedIds = new Set([...oldBatchMaterialIds].filter(id=>!savedIds.has(id)));

      state.materials = state.materials
        .filter(m => !(m.source === 'productionBatch' && m.batchId === batch.batchId))
        .concat(savedMaterials);

      state.recipeItems = state.recipeItems.filter(item => !deletedIds.has(item.materialId));
      batch.materialIds = [...savedIds];

      syncProductionInvestmentExpense();

      closeModals();
      renderAll();
      toast('Ingredientes conectados a Gastos, Panel principal y Contabilidad.');
    }

    function recipeMeasureStatus(productId){
      const items = recipeItemsForProduct(productId);
      const measured = items.filter(r=>num(r.qtyPerUnit)>0);
      const pending = items.filter(r=>num(r.qtyPerUnit)<=0);
      const measuredCost = measured.reduce((sum,r)=>sum + num(r.qtyPerUnit) * materialUnitCost(materialById(r.materialId)), 0);
      return {
        total: items.length,
        measured: measured.length,
        pending: pending.length,
        complete: items.length > 0 && pending.length === 0,
        hasAnyMeasure: measured.length > 0,
        measuredCost
      };
    }

    function renderRecipes(){
      renderProductionBatchCosting();
      const selectedId = document.getElementById('recipeProductSelect')?.value || state.products[0]?.id || '';
      const product = productById(selectedId);
      const qty = Math.max(1, num(document.getElementById('simQty')?.value || 20));
      const items = product ? recipeItemsForProduct(product.id) : [];
      const status = product ? recipeMeasureStatus(product.id) : {total:0, measured:0, pending:0, complete:false, hasAnyMeasure:false, measuredCost:0};
      const recipeOnlyCost = product ? recipeCost(product.id) : 0;
      const finalUnitCost = status.complete ? recipeOnlyCost : 0;
      const partialUnitCost = status.measuredCost || 0;
      const sales = product ? num(product.price) * qty : 0;
      const totalCost = status.complete ? finalUnitCost * qty : 0;
      const partialCost = status.hasAnyMeasure ? partialUnitCost * qty : 0;
      const profit = status.complete ? sales - totalCost : 0;

      const statusPanel = document.getElementById('recipeStatusPanel');
      if(statusPanel){
        if(!product){
          statusPanel.innerHTML = '<div class="empty">Crea un producto para organizar sus ingredientes.</div>';
        }else if(!status.total){
          statusPanel.innerHTML = `<div class="recipe-status-panel">
            <div class="recipe-status-card warning"><strong>Sin ingredientes registrados</strong><p>Ya puedes guardar los ingredientes que compras, aunque todavía no tengas la medida usada por producto.</p><button onclick="openRecipeBuilderModal('${product.id}')">Registrar ingredientes</button></div>
            <div class="recipe-status-card"><strong>Producto seleccionado</strong><p>${escapeHTML(product.name)} · Precio de venta ${money(product.price)}</p></div>
          </div>`;
        }else if(status.complete){
          statusPanel.innerHTML = `<div class="recipe-status-panel">
            <div class="recipe-status-card ok"><strong>Receta lista para calcular inversión</strong><p>Todos los ingredientes tienen medida por unidad. Ya puedes calcular costo unitario, inversión y ganancia.</p><button onclick="openRecipeBuilderModal('${product.id}')">Editar ingredientes</button></div>
            <div class="recipe-status-card"><strong>${status.total} ingredientes medidos</strong><p>Costo unitario calculado: ${money(recipeOnlyCost)}</p></div>
          </div>`;
        }else{
          statusPanel.innerHTML = `<div class="recipe-status-panel">
            <div class="recipe-status-card warning"><strong>Ingredientes guardados, medidas pendientes</strong><p>Tienes ${status.total} ingredientes registrados. Faltan medidas en ${status.pending}. Puedes completar la cantidad usada por unidad cuando la tengas.</p><button onclick="openRecipeBuilderModal('${product.id}')">Agregar medidas</button></div>
            <div class="recipe-status-card"><strong>Cálculo parcial</strong><p>${status.measured} ingrediente${status.measured===1?'':'s'} con medida. Costo parcial: ${money(partialUnitCost)} por unidad.</p></div>
          </div>`;
        }
      }

      document.getElementById('recipeCostMetrics').innerHTML = product ? [
        ['Precio venta', money(product.price), 'Valor cobrado por unidad'],
        ['Ingredientes', String(status.total), status.pending ? `${status.pending} pendientes de medida` : 'Todos con medida'],
        ['Costo unitario', status.complete ? money(recipeOnlyCost) : (status.hasAnyMeasure ? `Parcial ${money(partialUnitCost)}` : 'Pendiente'), status.complete ? 'Calculado con todas las medidas' : 'Agrega medidas para calcular final'],
        [`Inversión ${qty} und.`, status.complete ? money(totalCost) : (status.hasAnyMeasure ? `Parcial ${money(partialCost)}` : 'Pendiente'), status.complete ? 'Costo total de producción' : 'No es final hasta completar medidas'],
        ['Ganancia estimada', status.complete ? money(profit) : 'Pendiente', status.complete ? `Venta esperada: ${money(sales)}` : 'Disponible al completar medidas']
      ].map(m=>`<div class="mini-metric"><small>${m[0]}</small><strong>${m[1]}</strong><span>${m[2]}</span></div>`).join('') : '<div class="empty">Crea un producto para costear recetas.</div>';

      const measuredShopping = items.filter(r=>num(r.qtyPerUnit)>0).map(r=>{
        const m = materialById(r.materialId);
        const totalQty = num(r.qtyPerUnit) * qty;
        const cost = totalQty * materialUnitCost(m);
        return {recipe:r, material:m, totalQty, cost};
      });

      if(!product || !items.length){
        document.getElementById('simulatorResults').innerHTML = '<div class="empty">Registra primero los ingredientes que compras para este producto.</div>';
      }else if(!status.complete){
        document.getElementById('simulatorResults').innerHTML = `<div class="notice">
          <strong>Inversión pendiente de medidas.</strong><br>
          Ya tienes los ingredientes comprados, pero falta definir cuánto usa 1 unidad del producto.
          ${status.hasAnyMeasure ? `<br><br>Costo parcial con medidas actuales: <strong>${money(partialCost)}</strong> para ${qty} unidades.` : ''}
        </div>
        <div style="height:12px"></div>
        <button onclick="openRecipeBuilderModal('${product.id}')">Completar medidas</button>`;
      }else{
        document.getElementById('simulatorResults').innerHTML = `<div class="summary-list">
          <div class="summary-row"><span>Producto</span><strong>${escapeHTML(product.name)}</strong></div>
          <div class="summary-row"><span>Cantidad a fabricar</span><strong>${qty} unidades</strong></div>
          <div class="summary-row"><span>Costo unitario</span><strong>${money(finalUnitCost)}</strong></div>
          <div class="summary-row"><span>Inversión estimada</span><strong>${money(totalCost)}</strong></div>
          <div class="summary-row"><span>Venta esperada</span><strong>${money(sales)}</strong></div>
          <div class="summary-row total-line"><span>Ganancia estimada</span><strong>${money(profit)}</strong></div>
        </div><div style="height:12px"></div><div class="table-wrap"><table><thead><tr><th>Material a comprar / usar</th><th class="number">Cantidad total</th><th class="number">Costo estimado</th></tr></thead><tbody>${measuredShopping.map(x=>`<tr><td>${escapeHTML(x.material?.name || 'Material eliminado')}<br><small>${money(materialUnitCost(x.material))}/${x.material?.unit || ''}</small></td><td class="number">${Number(x.totalQty.toFixed(2))} ${x.material?.unit || ''}</td><td class="number">${money(x.cost)}</td></tr>`).join('')}</tbody></table></div>`;
      }

      document.getElementById('materialTotal').textContent = `${productionMaterials().length} ingredientes comprados · inversión ${money(productionIngredientInvestment())}`;
      document.getElementById('materialTable').innerHTML = productionMaterials().length ? `<div class="table-wrap action-table"><table><thead><tr><th>Material</th><th>Categoría</th><th class="number">Compra</th><th class="number">Precio compra</th><th class="number">Costo unitario</th><th>Proveedor</th><th>Actualizado</th><th>Acciones</th></tr></thead><tbody>${productionMaterials().map(m=>`<tr><td><strong>${escapeHTML(m.name)}</strong><br><small>${escapeHTML(m.notes||'')}</small></td><td>${escapeHTML(m.category||'')}</td><td class="number">${num(m.packageQty)} ${m.unit}</td><td class="number">${money(m.packageCost)}</td><td class="number">${money(materialUnitCost(m))}/${m.unit}</td><td>${escapeHTML(m.supplier||'')}</td><td>${m.updatedAt||''}</td><td><div class="row-actions"><button class="secondary" onclick="editMaterial('${m.id}')">Editar</button><button class="danger" onclick="deleteMaterial('${m.id}')">Eliminar</button></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aún no hay materiales registrados. Agrega ingredientes desde la receta del producto.</div>';

      document.getElementById('recipeTotal').textContent = product ? `${items.length} ingredientes · ${status.pending ? status.pending + ' pendientes de medida' : 'receta lista'}` : '';
      document.getElementById('recipeTable').innerHTML = product && items.length ? `<div class="recipe-guide-card">
        <div class="summary-list" style="margin-bottom:10px">
          <div class="summary-row"><span>Producto</span><strong>${escapeHTML(product.name)}</strong></div>
          <div class="summary-row"><span>Precio venta</span><strong>${money(product.price)}</strong></div>
          <div class="summary-row"><span>Costo unitario</span><strong>${status.complete ? money(recipeOnlyCost) : 'Pendiente de medidas'}</strong></div>
          <div class="summary-row total-line"><span>Estado</span><strong>${status.complete ? 'Listo para inversión' : 'Compras registradas'}</strong></div>
        </div>
        ${items.map(r=>{
          const m=materialById(r.materialId);
          const unit = m?.unit || '';
          const materialUnit = materialUnitCost(m);
          const hasMeasure = num(r.qtyPerUnit)>0;
          const ingredientCost = hasMeasure ? num(r.qtyPerUnit)*materialUnit : 0;
          return `<div class="recipe-guide-item">
            <div class="recipe-guide-main">
              <span><strong>${escapeHTML(m?.name || 'Material eliminado')}</strong><small>${escapeHTML(m?.category || 'Ingrediente')} · Compra registrada: ${num(m?.packageQty)} ${unit} por ${money(m?.packageCost || 0)}</small></span>
              <b>${hasMeasure ? money(ingredientCost) : '<span class="measure-pending">Medida pendiente</span>'}</b>
            </div>
            <div class="recipe-guide-numbers">
              <div><span>Costo material</span><b>${money(materialUnit)}/${unit}</b></div>
              <div><span>Uso en 1 unidad</span><b>${hasMeasure ? `${num(r.qtyPerUnit)} ${unit}` : 'Pendiente'}</b></div>
              <div><span>Costo en receta</span><b>${hasMeasure ? money(ingredientCost) : 'Pendiente'}</b></div>
            </div>
            ${r.notes ? `<small>${escapeHTML(r.notes)}</small>` : ''}
          </div>`;
        }).join('')}
        <div class="recipe-guide-actions">
          <button onclick="openRecipeBuilderModal('${product.id}')" data-recipe-action="open-builder" data-product-id="${product.id}">${status.complete ? 'Editar receta completa' : 'Agregar medidas pendientes'}</button>
          <button class="secondary" onclick="syncSelectedRecipeCost()" data-recipe-action="sync-cost">Calcular costo final</button>
        </div>
      </div>` : `<div class="empty">Este producto aún no tiene ingredientes. Usa el botón <strong>Abrir receta del producto</strong> para registrar lo que compras y su costo.</div>`;
    }

    function renderAccounting(){
      const type = document.getElementById('reportType').value;
      const batchId = document.getElementById('reportBatch').value || state.activeBatchId;
      const month = document.getElementById('reportMonth').value || monthNow();
      let orders = [], expenses = [], label = '';
      if(type === 'month'){
        orders = monthFilter(state.orders, 'createdAt', month);
        expenses = monthFilter(state.expenses, 'date', month);
        label = `Reporte mensual ${month}`;
      }else{
        orders = ordersForBatch(batchId);
        expenses = expensesForBatch(batchId);
        const b = batchById(batchId);
        label = b ? `${b.code} · ${b.name}` : 'Sin lote seleccionado';
      }
      const s = summarize(orders, expenses);
      document.getElementById('reportLabel').textContent = label;
      document.getElementById('reportMetrics').innerHTML = [
        ['Total vendido', money(s.totalSold), `${s.units} unidades vendidas`],
        ['Total recibido', money(s.totalReceived), 'Dinero que ya entró'],
        ['Total inversión', money(s.investment), s.investmentMode==='gastos' ? `Tomado de gastos registrados: ${money(s.extraExpenses)}` : `Estimado con costo unitario: ${money(s.productCost)}`],
        ['Ganancia del reporte', money(s.estimatedProfit), `Ganancia real en caja: ${money(s.realProfit)}`]
      ].map(m=>`<div class="card metric"><small>${m[0]}</small><strong>${m[1]}</strong><span>${m[2]}</span></div>`).join('');
      const products = groupProducts(orders);
      document.getElementById('reportProducts').innerHTML = products.length ? `<div class="table-wrap"><table><thead><tr><th>Producto</th><th class="number">Cantidad</th><th class="number">Ventas</th><th class="number">Costo</th></tr></thead><tbody>${products.map(p=>`<tr><td>${escapeHTML(p.name)}</td><td class="number">${p.qty}</td><td class="number">${money(p.sold)}</td><td class="number">${money(p.cost)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Sin productos vendidos.</div>';
      document.getElementById('reportPayments').innerHTML = `<div class="summary-list">
        <div class="summary-row"><span>Total pedidos</span><strong>${orders.length}</strong></div>
        <div class="summary-row"><span>Pedidos pagados</span><strong>${orders.filter(o=>paymentStatus(o)==='pagado').length}</strong></div>
        <div class="summary-row"><span>Pedidos con abono</span><strong>${orders.filter(o=>paymentStatus(o)==='abono').length}</strong></div>
        <div class="summary-row"><span>Pedidos pendientes</span><strong>${orders.filter(o=>paymentStatus(o)==='pendiente').length}</strong></div>
        <div class="summary-row"><span>Cartera pendiente</span><strong>${money(s.totalPending)}</strong></div>
      </div>`;
      const pending = orders.filter(o=>saldo(o)>0);
      document.getElementById('reportPendingTotal').textContent = `${pending.length} pendientes · ${money(pending.reduce((a,o)=>a+saldo(o),0))}`;
      document.getElementById('reportPendingTable').innerHTML = pending.length ? renderOrderMiniTable(pending) : '<div class="empty">No hay clientes pendientes por pagar en este reporte.</div>';
    }



    function etiquetarTablasMoviles(){
      document.querySelectorAll('table').forEach(table=>{
        const headers = Array.from(table.querySelectorAll('thead th')).map(th=>th.textContent.trim() || 'Dato');
        table.querySelectorAll('tbody tr').forEach(row=>{
          Array.from(row.children).forEach((cell,index)=>{
            if(cell && cell.tagName === 'TD') cell.setAttribute('data-label', headers[index] || 'Dato');
          });
        });
      });
    }

    const observadorTablasMoviles = new MutationObserver(()=>{
      clearTimeout(window.__mobileTableTimer);
      window.__mobileTableTimer = setTimeout(etiquetarTablasMoviles, 30);
    });
    observadorTablasMoviles.observe(document.body, {childList:true, subtree:true});

    function renderAll(){
      syncProductionInvestmentExpense();
      fillSelects(); renderDashboard(); renderBatches(); renderProducts(); renderRecipes(); renderOrders(); renderExpenses(); renderAccounting(); etiquetarTablasMoviles(); save();
    }

    document.getElementById('activeBatchSelect').addEventListener('change', e=>{state.activeBatchId=e.target.value; ensureProductionBatch(); renderAll(); toast('Lote activo actualizado.');});

    document.getElementById('batchForm').addEventListener('submit', e=>{
      e.preventDefault();
      const safeStatus=['abierto','preparacion','entregado'].includes(batchStatus.value)?batchStatus.value:'abierto';
      const b={id:uid('lote'),code:nextBatchCode(),name:batchName.value.trim(),openDate:batchOpen.value,deliveryDate:batchDelivery.value,status:safeStatus,notes:batchNotes.value.trim(),archived:false,closureHistory:[],createdAt:new Date().toISOString()};
      state.batches.push(b); state.activeBatchId=b.id; addAudit('batch_created',{batchId:b.id,batchCode:b.code}); e.target.reset(); batchOpen.value=today(); batchDelivery.value=today(); closeModals(); renderAll(); toast('Lote creado correctamente.');
    });

    document.getElementById('productForm').addEventListener('submit', e=>{
      e.preventDefault();
      const id = editingProductId.value;
      const data = {name:productName.value.trim(), price:num(productPrice.value), cost:num(productCost.value), active:productActive.value==='true'};
      if(id){ const p = productById(id); Object.assign(p,data); toast('Producto actualizado.'); }
      else { state.products.push({id:uid('prod'), ...data}); toast('Producto creado.'); }
      resetProductForm(); closeModals(); renderAll();
    });

    document.getElementById('orderForm').addEventListener('submit', e=>{
      e.preventDefault();
      const id = editingOrderId.value;
      const existing=id?state.orders.find(x=>x.id===id):null;
      const targetBatchId=existing?existing.batchId:orderBatch.value; if(!batchIsWritable(targetBatchId,existing?'editar este pedido':'crear el pedido'))return;
      const hasFinancialMovement = existing && (num(existing.paid)>0 || paymentHistory(existing).length>0 || isPaymentLocked(existing));
      const product = hasFinancialMovement ? productById(existing.productId) : productById(orderProduct.value);
      if(!product){ toast('Debes crear un producto activo.'); return; }

      const qty = hasFinancialMovement ? num(existing.quantity) : Math.max(1,num(orderQty.value));
      const total = hasFinancialMovement ? num(existing.total) : qty * num(product.price);
      const initialPaid = existing ? num(existing.paid) : Math.min(Math.max(0,num(orderPaid.value)), total);
      const data = {
        batchId:hasFinancialMovement ? existing.batchId : orderBatch.value,
        client:orderClient.value.trim(), phone:orderPhone.value.trim(),
        productId:product.id, productName:hasFinancialMovement ? existing.productName : product.name,
        unitPrice:hasFinancialMovement ? num(existing.unitPrice) : num(product.price),
        unitCost:hasFinancialMovement ? num(existing.unitCost) : effectiveProductCost(product),
        quantity:qty, total, paid:initialPaid,
        deliveryStatus:orderDeliveryStatus.value, createdAt:orderDate.value, notes:orderNotes.value.trim(),
        updatedAt:new Date().toISOString()
      };

      if(existing){
        Object.assign(existing,data);
        existing.paymentHistory = paymentHistory(existing);
        existing.paymentLocked = isPaymentLocked(existing);
        toast('Pedido actualizado sin alterar su historial de pagos.');
      } else {
        const order = {
          id:uid('ped'), ...data,
          createdRecordAt:new Date().toISOString(),
          paymentHistory:[],
          paymentLocked:initialPaid>=total && total>0
        };
        if(initialPaid>0){
          order.paymentHistory.push({
            id:uid('pago'), amount:initialPaid, date:orderDate.value || today(),
            method:'Registrado con el pedido', reference:'', note:'Pago inicial registrado al crear el pedido.',
            type:initialPaid>=total ? 'pago_total' : 'abono_inicial', source:'order_create',
            createdAt:new Date().toISOString()
          });
          if(order.paymentLocked) order.paidAt = orderDate.value || today();
        }
        state.orders.push(order);
        toast(order.paymentLocked ? 'Pedido registrado y pago completo bloqueado.' : (initialPaid>0 ? 'Pedido registrado con abono inicial.' : 'Pedido registrado.'));
      }
      resetOrderForm(); closeModals(); renderAll();
    });

    document.getElementById('paymentForm').addEventListener('submit', e=>{
      e.preventDefault();
      const o=state.orders.find(x=>x.id===paymentOrderId.value);
      if(!o){ alert('No se encontró el pedido.'); return; }
      const result=registerPayment(o, paymentAmount.value, {
        method:paymentMethod.value,
        date:paymentDate.value || today(),
        reference:paymentReference.value.trim(),
        note:paymentNote.value.trim(),
        source:'payment_modal'
      });
      if(!result.ok){ alert(result.message); return; }
      closeModals();
      renderAll();
      toast(result.completed ? 'Pago completado y bloqueado.' : `Abono registrado. Saldo: ${money(result.balance)}.`);
    });

    document.getElementById('expenseForm').addEventListener('submit', e=>{
      e.preventDefault();
      const id=editingExpenseId.value; const existingExpense=id?state.expenses.find(x=>x.id===id):null; const targetBatchId=existingExpense?.batchId||expenseBatch.value; if(!batchIsWritable(targetBatchId,id?'editar este gasto':'registrar este gasto'))return;
      const data={batchId:expenseBatch.value,concept:expenseConcept.value.trim(),category:expenseCategory.value,amount:num(expenseAmount.value),date:expenseDate.value};
      if(id){ const ex=state.expenses.find(x=>x.id===id); Object.assign(ex,data); toast('Gasto actualizado.'); }
      else { state.expenses.push({id:uid('gas'), ...data}); toast('Gasto registrado.'); }
      resetExpenseForm(); closeModals(); renderAll();
    });

    document.getElementById('materialForm').addEventListener('submit', e=>{
      e.preventDefault();
      const id = editingMaterialId.value;
      const data = {
        name:materialName.value.trim(), category:materialCategory.value,
        packageQty:Math.max(0,num(materialPackageQty.value)), unit:materialUnit.value,
        packageCost:Math.max(0,num(materialPackageCost.value)), supplier:materialSupplier.value.trim(),
        updatedAt:materialUpdatedAt.value, notes:materialNotes.value.trim()
      };
      if(id){ const m=materialById(id); Object.assign(m,data); toast('Material actualizado y costos recalculados.'); }
      else { state.materials.push({id:uid('mat'), ...data}); toast('Material creado.'); }
      resetMaterialForm(); closeModals(); renderAll();
    });

    document.getElementById('recipeForm').addEventListener('submit', e=>{
      e.preventDefault();
      const id = editingRecipeItemId.value;
      const data = {productId:recipeProduct.value, materialId:recipeMaterial.value, qtyPerUnit:Math.max(0,num(recipeQtyPerUnit.value)), notes:recipeNotes.value.trim()};
      if(!data.productId || !data.materialId){ toast('Debes seleccionar producto y material.'); return; }
      if(id){ const r=state.recipeItems.find(x=>x.id===id); Object.assign(r,data); toast('Ingrediente de receta actualizado.'); }
      else { state.recipeItems.push({id:uid('rec'), ...data}); toast('Ingrediente agregado a la receta.'); }
      document.getElementById('recipeProductSelect').value = data.productId;
      resetRecipeForm(); closeModals(); renderAll();
    });

    ['filterOrderBatch','filterPayment','filterClient','filterExpenseBatch','reportBatch','reportMonth','reportType','recipeProductSelect','simQty'].forEach(id=>{
      document.getElementById(id).addEventListener('input', renderAll);
      document.getElementById(id).addEventListener('change', renderAll);
    });

    ['recipeBuilderProduct','recipeBuilderQty'].forEach(id=>{
      const el = document.getElementById(id);
      if(!el) return;
      el.addEventListener('input', id==='recipeBuilderProduct' ? loadRecipeBuilderRows : recalcRecipeBuilder);
      el.addEventListener('change', id==='recipeBuilderProduct' ? loadRecipeBuilderRows : recalcRecipeBuilder);
    });
    const recipeBuilderRowsEl = document.getElementById('recipeBuilderRows');
    if(recipeBuilderRowsEl){
      recipeBuilderRowsEl.addEventListener('input', recalcRecipeBuilder);
      recipeBuilderRowsEl.addEventListener('change', recalcRecipeBuilder);
    }

    const productionPurchaseRowsEl = document.getElementById('productionPurchaseRows');
    if(productionPurchaseRowsEl){
      productionPurchaseRowsEl.addEventListener('input', recalcProductionPurchase);
      productionPurchaseRowsEl.addEventListener('change', recalcProductionPurchase);
    }

    function setActiveBatch(id){
      const b=batchById(id);if(!b)return;if(isBatchArchived(b)){alert('Este lote está archivado. Restáuralo antes de usarlo.');return;}if(isBatchClosed(b)){alert('Este lote está cerrado. Reábrelo antes de registrar nuevas operaciones.');return;}state.activeBatchId=id;ensureProductionBatch();renderAll();showView('dashboard');toast('Ahora estás trabajando con este lote.');
    }
    function changeBatchStatus(id){
      const b=batchById(id);if(!b||isBatchArchived(b))return;if(isBatchClosed(b)){reopenBatch(id);return;}if(b.status==='entregado'){openBatchCloseModal(id);return;}b.status=b.status==='abierto'?'preparacion':'entregado';b.updatedAt=new Date().toISOString();addAudit('batch_status_changed',{batchId:b.id,batchCode:b.code,status:b.status});renderAll();toast(`Lote actualizado: ${b.status==='preparacion'?'en preparación':'entregado'}.`);
    }
    function openBatchCloseModal(id,viewingClosed=false){
      const b=batchById(id);if(!b)return;const viewing=viewingClosed||isBatchClosed(b);const snap=viewing?(b.closure||b.closureHistory?.[b.closureHistory.length-1]||buildBatchClosureSnapshot(b)):buildBatchClosureSnapshot(b);batchCloseId.value=b.id;batchCloseModalTitle.textContent=viewing?`Cierre ${b.code}`:`Cerrar ${b.code}`;batchCloseModalSubtitle.textContent=viewing?'Consulta la fotografía financiera guardada al cerrar este lote.':'Revisa ventas, recaudo, cartera y entregas antes de confirmar.';batchCloseSummary.innerHTML=closureSummaryHTML(b,snap,viewing);batchCloseNote.value=snap.note||b.closeNote||'';batchCloseNote.disabled=viewing;batchCloseNoteWrap.style.display=viewing?(batchCloseNote.value?'grid':'none'):'grid';confirmBatchCloseBtn.style.display=viewing?'none':'inline-flex';confirmBatchCloseBtn.disabled=snap.pendingDeliveries>0;openModal('batchCloseModal');
    }
    function confirmBatchClose(){
      const b=batchById(batchCloseId.value);if(!b||isBatchClosed(b)||isBatchArchived(b))return;const snap=buildBatchClosureSnapshot(b);if(snap.pendingDeliveries>0){alert(`No puedes cerrar el lote todavía. Faltan ${snap.pendingDeliveries} pedido${snap.pendingDeliveries===1?'':'s'} por entregar.`);return;}snap.note=batchCloseNote.value.trim();if(!confirm(`¿Confirmar el cierre de ${b.code}?\n\nVentas: ${money(snap.summary.totalSold)}\nRecibido: ${money(snap.summary.totalReceived)}\nPendiente por cobrar: ${money(snap.summary.totalPending)}\n\nDespués del cierre no se podrán agregar pedidos, gastos ni modificar la producción sin reabrir el lote.`))return;b.status='cerrado';b.closedAt=snap.closedAt;b.closeNote=snap.note;b.closure=snap;b.closureHistory=Array.isArray(b.closureHistory)?b.closureHistory:[];b.closureHistory.push(JSON.parse(JSON.stringify(snap)));b.updatedAt=new Date().toISOString();addAudit('batch_closed',{batchId:b.id,batchCode:b.code,closureId:snap.id,totalSold:snap.summary.totalSold,totalPending:snap.summary.totalPending});if(state.activeBatchId===b.id)state.activeBatchId=writableBatches().find(x=>x.id!==b.id)?.id||'';closeModals();renderAll();toast('Lote cerrado y protegido. La cartera pendiente puede seguir cobrándose.');
    }
    function reopenBatch(id){
      const b=batchById(id);if(!b||!isBatchClosed(b)||isBatchArchived(b))return;const reason=prompt(`Reabrir ${b.code} permitirá volver a editar operaciones del lote.\n\nEscribe el motivo de reapertura:`,'Corrección operativa');if(reason===null)return;if(!String(reason).trim()){alert('Debes indicar un motivo para conservar la trazabilidad.');return;}if(!confirm(`¿Reabrir ${b.code}? El cierre anterior se conservará en el historial.`))return;b.status='entregado';b.lastReopenedAt=new Date().toISOString();b.lastReopenReason=String(reason).trim();b.updatedAt=new Date().toISOString();addAudit('batch_reopened',{batchId:b.id,batchCode:b.code,reason:b.lastReopenReason});state.activeBatchId=b.id;renderAll();toast('Lote reabierto. El cierre anterior permanece en el historial.');
    }
    function archiveBatch(id){
      const b=batchById(id);if(!b||isBatchArchived(b))return;const reason=prompt(`Archivar ${b.code} lo quitará del trabajo diario sin borrar pedidos, pagos ni gastos.\n\nMotivo:`,isBatchClosed(b)?'Lote finalizado':'Organización del historial');if(reason===null)return;if(!confirm(`¿Archivar ${b.code}? Ningún registro relacionado será eliminado.`))return;b.archived=true;b.archivedAt=new Date().toISOString();b.archiveReason=String(reason||'').trim();b.updatedAt=new Date().toISOString();addAudit('batch_archived',{batchId:b.id,batchCode:b.code,reason:b.archiveReason});if(state.activeBatchId===b.id)state.activeBatchId=writableBatches().find(x=>x.id!==b.id)?.id||'';renderAll();toast('Lote archivado sin eliminar información.');
    }
    function restoreBatch(id){const b=batchById(id);if(!b||!isBatchArchived(b))return;b.archived=false;b.restoredAt=new Date().toISOString();b.updatedAt=new Date().toISOString();addAudit('batch_restored',{batchId:b.id,batchCode:b.code});renderAll();toast('Lote restaurado.');}
    function deleteBatch(id){
      const b=batchById(id);if(!b)return;const hasData=state.orders.some(o=>o.batchId===id)||state.expenses.some(e=>e.batchId===id)||state.materials.some(m=>m.batchId===id)||Boolean(state.productionBatches?.[id]);if(hasData){alert('Este lote contiene información relacionada y no puede eliminarse. Usa “Archivar” para conservar pedidos, pagos, gastos y producción.');return;}if(!confirm(`¿Eliminar definitivamente el lote vacío ${b.code}?`))return;addAudit('batch_deleted_empty',{batchId:b.id,batchCode:b.code});state.batches=state.batches.filter(x=>x.id!==id);if(state.activeBatchId===id)state.activeBatchId=writableBatches()[0]?.id||'';renderAll();toast('Lote vacío eliminado.');
    }

    function editProduct(id){
      const p=productById(id); if(!p) return;
      editingProductId.value=p.id; productName.value=p.name; productPrice.value=p.price; productCost.value=p.cost; productActive.value=String(p.active);
      document.getElementById('productModalTitle').textContent = 'Editar producto';
      openModal('productModal');
      setTimeout(()=>productName.focus(), 80);
    }
    function resetProductForm(){ editingProductId.value=''; productForm.reset(); productActive.value='true'; document.getElementById('productModalTitle').textContent = 'Nuevo producto'; }
    function deleteProduct(id){ if(!confirm('¿Eliminar este producto? Los pedidos anteriores conservarán el nombre y precio guardado.')) return; state.products=state.products.filter(p=>p.id!==id); renderAll(); toast('Producto eliminado.'); }

    function editOrder(id){
      const o=state.orders.find(x=>x.id===id); if(!o) return; if(!batchIsWritable(o.batchId,'editar este pedido'))return;
      showView('orders');
      editingOrderId.value=o.id; orderBatch.value=o.batchId; orderClient.value=o.client; orderPhone.value=o.phone; orderProduct.value=o.productId; orderQty.value=o.quantity; orderPaid.value=o.paid; orderDeliveryStatus.value=o.deliveryStatus; orderDate.value=o.createdAt||today(); orderNotes.value=o.notes||'';
      const hasFinancialMovement = num(o.paid)>0 || paymentHistory(o).length>0 || isPaymentLocked(o);
      orderPaid.disabled = true;
      orderPaid.title = 'Los pagos se administran con el botón Abono para conservar el historial.';
      orderProduct.disabled = hasFinancialMovement;
      orderQty.disabled = hasFinancialMovement;
      orderBatch.disabled = hasFinancialMovement;
      document.getElementById('orderModalTitle').textContent = hasFinancialMovement ? 'Editar datos del pedido' : 'Editar pedido';
      openModal('orderModal');
      setTimeout(()=>orderClient.focus(), 80);
    }
    function resetOrderForm(){
      editingOrderId.value=''; orderForm.reset();
      orderBatch.disabled=false; orderProduct.disabled=false; orderQty.disabled=false; orderPaid.disabled=false;
      orderPaid.title='';
      orderBatch.value=state.activeBatchId||''; orderQty.value=1; orderPaid.value=0; orderDate.value=today();
      document.getElementById('orderModalTitle').textContent = 'Registrar pedido';
    }
    function payOrder(id){ openPaymentModal(id); }
    let orderDetailCurrentId = '';

    function openPaymentModal(id){
      const o=state.orders.find(x=>x.id===id); if(!o) return;
      if(saldo(o)<=0 || isPaymentLocked(o)){
        alert('Este pedido ya está pagado y su confirmación quedó bloqueada.');
        return;
      }
      paymentOrderId.value=o.id;
      paymentAmount.value='';
      paymentAmount.max=String(saldo(o));
      paymentMethod.value='Efectivo';
      paymentDate.value=today();
      paymentReference.value='';
      paymentNote.value='';
      paymentOrderSummary.innerHTML = `<strong>${escapeHTML(o.client)}</strong> · ${escapeHTML(o.productName)}
        <p>Total ${money(o.total)} · Abonado ${money(o.paid)} · <strong>Saldo ${money(saldo(o))}</strong></p>`;
      openModal('paymentModal');
      setTimeout(()=>paymentAmount.focus(),80);
    }

    function fillPaymentBalance(){
      const o=state.orders.find(x=>x.id===paymentOrderId.value); if(!o) return;
      paymentAmount.value=Math.round(saldo(o));
      paymentAmount.focus();
    }

    function registerPayment(order, amount, meta={}){
      if(!order) return {ok:false, message:'Pedido no encontrado.'};
      if(isPaymentLocked(order) || saldo(order)<=0) return {ok:false, message:'El pedido ya está pagado y bloqueado.'};
      const balanceBefore = saldo(order);
      const value = Math.round(num(amount));
      if(value<=0) return {ok:false, message:'El abono debe ser mayor que cero.'};
      if(value>balanceBefore) return {ok:false, message:`El abono supera el saldo pendiente de ${money(balanceBefore)}.`};

      order.paymentHistory = paymentHistory(order);
      order.paymentHistory.push({
        id:uid('pago'),
        amount:value,
        date:meta.date || today(),
        method:meta.method || 'Otro',
        reference:meta.reference || '',
        note:meta.note || '',
        type:value>=balanceBefore ? 'pago_total' : 'abono',
        source:meta.source || 'payment_modal',
        createdAt:new Date().toISOString()
      });
      order.paid=Math.min(num(order.total),num(order.paid)+value); order.updatedAt=new Date().toISOString();
      const paymentBatch=batchById(order.batchId); addAudit(isBatchClosed(paymentBatch)?'payment_after_batch_close':'payment_registered',{batchId:order.batchId,orderId:order.id,amount:value,method:meta.method||'Otro'});

      if(saldo(order)<=0){
        order.paid = num(order.total);
        order.paymentLocked = true;
        order.paidAt = meta.date || today();
      }
      return {ok:true, completed:isPaymentLocked(order), balance:saldo(order)};
    }

    function markOrderPaidFromChecklist(id){
      const o=state.orders.find(x=>x.id===id); if(!o) return;
      if(isPaymentLocked(o) || saldo(o)<=0) return;
      if(num(o.paid)>0){
        alert(`No ha terminado de pagar.\n\nHa abonado: ${money(o.paid)}\nTodavía debe: ${money(saldo(o))}\n\nUsa el botón “+ Abono” para completar el saldo.`);
        return;
      }
      if(!confirm(`¿Confirmar que ${o.client} pagó el total de ${money(o.total)}?\n\nUna vez marcado, este check quedará bloqueado y no se podrá quitar.`)) return;
      const result = registerPayment(o, saldo(o), {
        method:'Marcado manual',
        date:today(),
        note:'Pago total confirmado desde el checklist.',
        source:'checklist'
      });
      if(!result.ok){ alert(result.message); return; }
      renderAll();
      toast('Pago total confirmado. El check quedó bloqueado.');
    }

    function openOrderDetail(id){
      const o=state.orders.find(x=>x.id===id); if(!o) return;
      orderDetailCurrentId=id;
      const b=batchById(o.batchId);
      const history=paymentHistory(o);
      const historyHtml = history.length
        ? history.slice().reverse().map(p=>`<div class="payment-history-item">
            <div><strong>${money(p.amount)}</strong><small>${escapeHTML(p.type==='pago_total'?'Pago total':'Abono')}</small></div>
            <div>${escapeHTML(p.date||'Sin fecha')}<small>${escapeHTML(p.method||'Sin método')}</small></div>
            <div>${escapeHTML(p.reference||p.note||'Sin observación')}<small>${escapeHTML(p.note && p.reference ? p.note : '')}</small></div>
          </div>`).join('')
        : (num(o.paid)>0
            ? `<div class="notice">Este pedido tiene un saldo pagado anterior al historial detallado. El total se conserva correctamente, aunque esos movimientos previos no tienen desglose individual.</div>`
            : '<div class="empty">Todavía no hay abonos registrados.</div>');

      orderDetailBody.innerHTML = `
        <div class="payment-detail-grid">
          <div class="payment-detail-card"><small>Cliente</small><strong>${escapeHTML(o.client)}</strong><span class="payment-client-meta">${escapeHTML(o.phone||'Sin teléfono')}</span></div>
          <div class="payment-detail-card"><small>Pedido</small><strong>${escapeHTML(o.productName)}</strong><span class="payment-client-meta">${num(o.quantity)} unidades · ${escapeHTML(b?.code||'Sin lote')}</span></div>
          <div class="payment-detail-card"><small>Valor total</small><strong>${money(o.total)}</strong></div>
          <div class="payment-detail-card"><small>Total abonado</small><strong>${money(o.paid)}</strong></div>
          <div class="payment-detail-card"><small>Saldo pendiente</small><strong>${money(saldo(o))}</strong></div>
          <div class="payment-detail-card"><small>Estado</small><strong>${paymentStatus(o)==='pagado'?'Pagado':paymentStatus(o)==='abono'?'Abono parcial':'Pendiente'}</strong></div>
        </div>
        <div class="card" style="margin-bottom:14px">
          <div class="summary-row"><span>Fecha del pedido</span><strong>${escapeHTML(o.createdAt||'')}</strong></div>
          <div class="summary-row"><span>Entrega</span><strong>${escapeHTML(o.deliveryStatus||'pendiente')}</strong></div>
          <div class="summary-row"><span>Precio unitario</span><strong>${money(o.unitPrice)}</strong></div>
          <div class="summary-row"><span>Observaciones</span><strong>${escapeHTML(o.notes||'Sin observaciones')}</strong></div>
        </div>
        <div class="section-title" style="margin-top:14px"><h3>Historial de abonos</h3><span class="badge-total">${history.length} movimientos</span></div>
        <div class="payment-history">${historyHtml}</div>`;

      const btn=document.getElementById('orderDetailPaymentButton');
      if(btn){
        btn.disabled=saldo(o)<=0 || isPaymentLocked(o);
        btn.textContent=btn.disabled?'Pago confirmado':`Registrar abono · debe ${money(saldo(o))}`;
      }
      openModal('orderDetailModal');
    }

    function openPaymentFromDetail(){
      const id=orderDetailCurrentId;
      closeModals();
      if(id) openPaymentModal(id);
    }

    function sendPaymentReminder(id){
      const o = state.orders.find(x=>x.id===id); if(!o) return;
      if(saldo(o) <= 0){ alert('Este pedido ya aparece como pagado. No tiene saldo pendiente para cobrar.'); return; }
      const phone = normalizePhoneForWhatsapp(o.phone);
      if(!phone){ alert('Este cliente no tiene número de teléfono registrado. Agrega el número en el pedido para enviar el recordatorio por WhatsApp.'); return; }
      const url = `https://wa.me/${phone}?text=${encodeURIComponent(paymentReminderMessage(o))}`;
      window.open(url, '_blank');
      toast('Recordatorio abierto en WhatsApp.');
    }
    function toggleDelivery(id){const o=state.orders.find(x=>x.id===id);if(!o)return;if(!batchIsWritable(o.batchId,'cambiar la entrega'))return;o.deliveryStatus=o.deliveryStatus==='entregado'?'pendiente':'entregado';o.updatedAt=new Date().toISOString();renderAll();toast('Estado de entrega actualizado.');}
    function deleteOrder(id){
      const o=state.orders.find(x=>x.id===id);if(!o)return;if(!batchIsWritable(o.batchId,'eliminar este pedido'))return;
      if(num(o.paid)>0 || paymentHistory(o).length>0 || isPaymentLocked(o)){
        alert(`Este pedido tiene pagos registrados (${money(o.paid)}). Para proteger la trazabilidad financiera no puede eliminarse.`);
        return;
      }
      if(!confirm('¿Eliminar este pedido sin pagos registrados?')) return;
      state.orders=state.orders.filter(o=>o.id!==id); renderAll(); toast('Pedido eliminado.');
    }

    function editExpense(id){
      const e=state.expenses.find(x=>x.id===id);if(!e)return;if(!batchIsWritable(e.batchId,'editar este gasto'))return;
      if(e.source==='productionBatch'){ toast('Este gasto se actualiza desde Recetas y costeo para evitar duplicar datos.'); showView('recipes'); return; }
      showView('expenses'); editingExpenseId.value=e.id; expenseBatch.value=e.batchId; expenseConcept.value=e.concept; expenseCategory.value=e.category; expenseAmount.value=e.amount; expenseDate.value=e.date;
      document.getElementById('expenseModalTitle').textContent = 'Editar gasto o inversión';
      openModal('expenseModal');
      setTimeout(()=>expenseConcept.focus(), 80);
    }
    function resetExpenseForm(){ editingExpenseId.value=''; expenseForm.reset(); expenseBatch.value=state.activeBatchId||''; expenseDate.value=today(); document.getElementById('expenseModalTitle').textContent = 'Registrar gasto o inversión'; }
    function deleteExpense(id){const exp=state.expenses.find(e=>e.id===id);if(!exp)return;if(!batchIsWritable(exp.batchId,'eliminar este gasto'))return;if(exp?.source==='productionBatch'){ toast('Este gasto es automático desde Recetas y costeo. Modifícalo allí.'); showView('recipes'); return; } if(!confirm('¿Eliminar este gasto?')) return; state.expenses=state.expenses.filter(e=>e.id!==id); renderAll(); toast('Gasto eliminado.'); }

    function showRecipeFor(id){
      showView('recipes');
      const el = document.getElementById('recipeProductSelect');
      if(el) el.value = id;
      renderAll();
    }
    function editMaterial(id){
      const m=materialById(id);if(!m)return;if(m.batchId&&!batchIsWritable(m.batchId,'editar este ingrediente comprado'))return;
      editingMaterialId.value=m.id; materialName.value=m.name; materialCategory.value=m.category||'Ingredientes'; materialPackageQty.value=m.packageQty; materialUnit.value=m.unit||'g'; materialPackageCost.value=m.packageCost; materialSupplier.value=m.supplier||''; materialUpdatedAt.value=m.updatedAt||today(); materialNotes.value=m.notes||'';
      document.getElementById('materialModalTitle').textContent = 'Editar material o insumo';
      openModal('materialModal');
      setTimeout(()=>materialName.focus(), 80);
    }
    function resetMaterialForm(){ editingMaterialId.value=''; materialForm.reset(); materialCategory.value='Ingredientes'; materialUnit.value='g'; materialUpdatedAt.value=today(); document.getElementById('materialModalTitle').textContent = 'Registrar material o insumo'; }
    function deleteMaterial(id){
      const material=materialById(id);if(!material)return;if(material.batchId&&!batchIsWritable(material.batchId,'eliminar este ingrediente comprado'))return;
      const used=state.recipeItems.some(r=>r.materialId===id);
      const msg = used ? 'Este material está en una o más recetas. Si lo eliminas, también se quitará de esas recetas. ¿Continuar?' : '¿Eliminar este material?';
      if(!confirm(msg)) return;
      state.materials = state.materials.filter(m=>m.id!==id);
      state.recipeItems = state.recipeItems.filter(r=>r.materialId!==id);
      renderAll(); toast('Material eliminado.');
    }
    function editRecipeItem(id){
      const r=state.recipeItems.find(x=>x.id===id); if(!r) return;
      editingRecipeItemId.value=r.id; recipeProduct.value=r.productId; recipeMaterial.value=r.materialId; recipeQtyPerUnit.value=r.qtyPerUnit; recipeNotes.value=r.notes||'';
      document.getElementById('recipeModalTitle').textContent = 'Editar ingrediente de receta';
      openModal('recipeModal');
      setTimeout(()=>recipeQtyPerUnit.focus(), 80);
    }
    function resetRecipeForm(){ editingRecipeItemId.value=''; recipeForm.reset(); recipeProduct.value=document.getElementById('recipeProductSelect')?.value || state.products[0]?.id || ''; recipeMaterial.value=state.materials[0]?.id || ''; recipeQtyPerUnit.value=''; document.getElementById('recipeModalTitle').textContent = 'Agregar ingrediente a receta'; }
    function deleteRecipeItem(id){ if(!confirm('¿Eliminar este ingrediente de la receta?')) return; state.recipeItems=state.recipeItems.filter(r=>r.id!==id); renderAll(); toast('Ingrediente eliminado de la receta.'); }
    function syncSelectedRecipeCost(){
      const product = productById(document.getElementById('recipeProductSelect')?.value);
      if(!product){ toast('Selecciona un producto.'); return; }
      const status = recipeMeasureStatus(product.id);
      if(status.total <= 0){
        toast('Primero registra los ingredientes comprados de este producto.');
        openRecipeBuilderModal(product.id);
        return;
      }
      if(!status.complete){
        toast('Faltan medidas por unidad. Completa la cantidad usada de cada ingrediente.');
        openRecipeBuilderModal(product.id);
        return;
      }
      const cost = recipeCost(product.id);
      if(cost <= 0){ toast('Revisa las cantidades y costos de la receta.'); return; }
      product.cost = Math.round(cost);
      renderAll();
      toast('Costo unitario actualizado con la receta completa.');
    }

    function downloadStateFile(data,filename){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);}
    function exportJSON(){downloadStateFile(state,`copia_dulce_antojo_postres_${APP_VERSION.replaceAll('.','_')}_${today()}.json`);toast('Copia de seguridad exportada.');}
    function validateImportedState(data){
      if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('La copia no contiene un objeto válido.');
      ['products','batches','orders','expenses'].forEach(key=>{if(!Array.isArray(data[key]))throw new Error(`Falta la colección ${key}.`);});
      const seen=new Set();[...data.batches,...data.orders,...data.expenses].forEach(item=>{if(!item||typeof item!=='object'||!item.id)throw new Error('Hay registros sin identificador.');const id=String(item.id);if(seen.has(id))throw new Error(`Identificador duplicado: ${id}`);seen.add(id);});
      data.orders.forEach(o=>{if(num(o.total)<0||num(o.paid)<0)throw new Error('Hay pedidos con valores negativos.');if(num(o.paid)>num(o.total)+.01)throw new Error('Hay un pedido con pago superior al total.');});return true;
    }
    let importInProgress=false;
    document.getElementById('importFile').addEventListener('change',e=>{const file=e.target.files[0];e.target.value='';if(!file||importInProgress)return;if(file.size>5*1024*1024){alert('La copia supera 5 MB. Por seguridad no se importó.');return;}importInProgress=true;const reader=new FileReader();reader.onload=()=>{try{const data=JSON.parse(reader.result);validateImportedState(data);const normalized=normalizeState(data);const summary=`Lotes: ${normalized.batches.length}\nPedidos: ${normalized.orders.length}\nGastos: ${normalized.expenses.length}\nProductos: ${normalized.products.length}`;if(!confirm(`La importación reemplazará el estado actual.\n\n${summary}\n\nAntes se descargará automáticamente una copia del estado actual. ¿Continuar?`))return;downloadStateFile(state,`RESPALDO_ANTES_IMPORTAR_${APP_VERSION.replaceAll('.','_')}_${today()}.json`);const previousAudit=Array.isArray(state.auditLog)?state.auditLog:[];state=normalized;state.auditLog=[...(state.auditLog||[]),...previousAudit.slice(-25)];addAudit('state_imported',{fileName:file.name,fileSize:file.size,batches:state.batches.length,orders:state.orders.length});save();renderAll();toast('Copia importada y respaldo previo descargado.');}catch(err){alert(`No se pudo importar el archivo. ${err.message||'Revisa que sea una copia válida.'}`);}finally{importInProgress=false;}};reader.onerror=()=>{importInProgress=false;alert('No fue posible leer el archivo seleccionado.');};reader.readAsText(file);});

    function escapeHTML(str){
      return String(str ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    }


    Object.assign(window, {
      showView,
      exportJSON,
      openBatchModal,
      openProductModal,
      openOrderModal,
      openExpenseModal,
      openMaterialModal,
      openRecipeModal,
      resetProductForm,
      resetOrderForm,
      resetExpenseForm,
      resetMaterialForm,
      resetRecipeForm,
      closeModals,
      backdropClose,
      closeMobileMorePanel,
      openMobileMorePanel,
      setActiveBatch,
      changeBatchStatus,
      openBatchCloseModal,
      confirmBatchClose,
      reopenBatch,
      archiveBatch,
      restoreBatch,
      deleteBatch,
      editProduct,
      showRecipeFor,
      deleteProduct,
      editOrder,
      payOrder,
      openPaymentModal,
      fillPaymentBalance,
      markOrderPaidFromChecklist,
      openOrderDetail,
      openPaymentFromDetail,
      sendPaymentReminder,
      toggleDelivery,
      deleteOrder,
      editExpense,
      deleteExpense,
      editMaterial,
      deleteMaterial,
      editRecipeItem,
      deleteRecipeItem,
      syncSelectedRecipeCost,
      openRecipeBuilderModal,
      addRecipeBuilderRow,
      removeRecipeBuilderRow,
      saveRecipeBuilder,
      recalcRecipeBuilder,
      recipeMeasureStatus,
      setupRecipeButtons,

      openProductionPurchaseModal,
      addProductionPurchaseRow,
      removeProductionPurchaseRow,
      saveProductionPurchase,
      recalcProductionPurchase,
      updateProductionQty,
      saveProductionQuantitiesFromUI,
      renderProductionBatchCosting,
    });


    function setupRecipeButtons(){
      document.addEventListener('click', (event)=>{
        const target = event.target.closest('[data-recipe-action]');
        if(!target) return;
        event.preventDefault();

        const action = target.dataset.recipeAction;
        const productId = target.dataset.productId || '';

        if(action === 'open-builder') openRecipeBuilderModal(productId);
        if(action === 'sync-cost') syncSelectedRecipeCost();
        if(action === 'add-row') addRecipeBuilderRow();
        if(action === 'save-builder') saveRecipeBuilder();
      });
    }

    function init(){
      state = loadState();
      setupNav();
      setupRecipeButtons();
      batchOpen.value=today(); batchDelivery.value=today(); orderDate.value=today(); paymentDate.value=today(); expenseDate.value=today(); materialUpdatedAt.value=today(); reportMonth.value=monthNow();
      document.body.dataset.view = 'dashboard'; fillSelects(); resetOrderForm(); resetExpenseForm(); resetMaterialForm(); resetRecipeForm(); renderMobileNavigation(); renderSectionGuide('dashboard'); updateMobileNavigationState('dashboard'); renderAll(); firebaseReady = true; startCloudSync();
    }

    async function bootstrapSecureApp(){
      const user = await waitForAuthenticatedUser();
      if(!user?.email) return;
      init();
    }

    bootstrapSecureApp().catch(()=>{
      const box = document.getElementById('authMessage');
      if(box){
        box.textContent = 'No fue posible iniciar el sistema. Recarga la página e intenta nuevamente.';
        box.className = 'auth-message show error';
      }
    });
