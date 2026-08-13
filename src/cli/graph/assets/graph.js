/**
 * NMG graph view — reusable, dependency-free canvas renderer.
 *
 * The template is data-agnostic: `NmgGraph.mount(container, data, options)`
 * renders any {nodes, edges} payload that follows the GraphData contract in
 * src/cli/graph-data.ts. Everything (DOM, styles hooks, simulation) is scoped
 * to the container, so the same script can drive several graphs on one page.
 *
 * Display rules that encode NMG semantics:
 *  - node color hashes `kind`, node radius scales with `memoryCount`
 *  - isolated nodes (degree 0) get a warning ring — recall debugging target
 *  - demoted edges render dashed; directed edges get an arrowhead
 *  - candidate (co-retrieval, not yet consolidated) edges render as faint
 *    dashed gray lines with weak spring force
 *  - edge width scales with `strength`
 */
window.NmgGraph = (() => {
  const TAU = Math.PI * 2;

  function mount(container, data, options = {}) {
    container.classList.add("nmg-graph");
    container.innerHTML = `
      <canvas id="canvas"></canvas>
      <div class="toolbar">
        <input type="search" placeholder="filter nodes…" />
        <label><input type="checkbox" class="hide-isolated" /> hide isolated</label>
      </div>
      <div class="legend"></div>
      <div class="tooltip"></div>
      <div class="detail">
        <button class="close" title="close">×</button>
        <h2></h2>
        <div class="meta"></div>
        <div class="summary"></div>
        <ul class="statements"></ul>
      </div>
      <div class="stats"></div>`;

    const canvas = container.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    const tooltip = container.querySelector(".tooltip");
    const detail = container.querySelector(".detail");
    const legend = container.querySelector(".legend");
    const searchInput = container.querySelector('input[type="search"]');
    const hideIsolatedInput = container.querySelector(".hide-isolated");
    const stats = container.querySelector(".stats");

    const nodes = data.nodes.map((node, index) => ({
      ...node,
      x: Math.cos((index / Math.max(1, data.nodes.length)) * TAU) * 200,
      y: Math.sin((index / Math.max(1, data.nodes.length)) * TAU) * 200,
      vx: 0,
      vy: 0,
      color: hashColor(node.kind, 62, 55),
      radius: 6 + Math.sqrt(node.memoryCount) * 2.5,
    }));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges = data.edges
      .map((edge) => ({
        ...edge,
        sourceNode: nodeById.get(edge.source),
        targetNode: nodeById.get(edge.target),
        color: edge.layer === "candidate" ? "#6e7681" : hashColor(edge.type, 70, 60),
      }))
      .filter((edge) => edge.sourceNode && edge.targetNode);

    // No edges at all: a force cloud carries no information, so lay the
    // nodes out on a deterministic grid and keep the simulation off.
    const hasEdges = edges.length > 0;
    if (!hasEdges && nodes.length > 0) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.6)));
      const rows = Math.ceil(nodes.length / cols);
      nodes.forEach((node, index) => {
        node.x = ((index % cols) - (cols - 1) / 2) * 140;
        node.y = (Math.floor(index / cols) - (rows - 1) / 2) * 100;
      });
    }

    const edgeTypes = [...new Set(edges.map((edge) => edge.type))].sort();
    const hiddenTypes = new Set();
    let hideIsolated = false;
    let filter = "";
    let hovered = null;
    let selected = null;
    let dragNode = null;
    let panning = false;
    let alpha = hasEdges ? 1 : 0; // simulation temperature; reheated by interaction
    const view = { x: 0, y: 0, k: 1 };

    // ---- legend -----------------------------------------------------------
    function renderLegend() {
      legend.innerHTML = "";
      for (const type of edgeTypes) {
        const count = edges.filter((edge) => edge.type === type).length;
        const sample = edges.find((edge) => edge.type === type);
        const item = document.createElement("div");
        item.className = `item${hiddenTypes.has(type) ? " off" : ""}`;
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = sample.color;
        const label = document.createElement("span");
        label.textContent = type;
        const tally = document.createElement("span");
        tally.className = "count";
        tally.textContent = String(count);
        item.append(swatch, label, tally);
        item.addEventListener("click", () => {
          if (hiddenTypes.has(type)) hiddenTypes.delete(type);
          else hiddenTypes.add(type);
          renderLegend();
          wake(0.3);
        });
        legend.append(item);
      }
    }
    renderLegend();

    // ---- layout -----------------------------------------------------------
    // Approximate, budget-conscious physics: local repulsion only (pairs
    // beyond REPULSION_CUTOFF ignore each other), fast cooling, and a hard
    // stop at alpha 0 — the frame loop then shuts down until interaction
    // wakes it. Good enough for a debug view, cheap enough to idle at 0% CPU.
    const REPULSION_CUTOFF_SQ = 500 * 500;
    function tick() {
      if (alpha <= 0) return;
      const visible = visibleNodes();
      const activeEdges = visibleEdges();
      const repulsion = 4000 * alpha;
      for (let i = 0; i < visible.length; i += 1) {
        const a = visible[i];
        for (let j = i + 1; j < visible.length; j += 1) {
          const b = visible[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distanceSq = dx * dx + dy * dy;
          if (distanceSq > REPULSION_CUTOFF_SQ) continue;
          if (distanceSq < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            distanceSq = 1;
          }
          const force = repulsion / distanceSq;
          const distance = Math.sqrt(distanceSq);
          a.vx += (dx / distance) * force;
          a.vy += (dy / distance) * force;
          b.vx -= (dx / distance) * force;
          b.vy -= (dy / distance) * force;
        }
        // weak centering keeps the cloud on screen
        a.vx -= a.x * 0.02 * alpha;
        a.vy -= a.y * 0.02 * alpha;
      }
      for (const edge of activeEdges) {
        const { sourceNode: a, targetNode: b } = edge;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const rest = 90 + (1 - clamp01(edge.strength)) * 90;
        // Candidate pairs are hints, not structure: let them tug weakly so
        // consolidated topology dominates the layout.
        const layerWeight = edge.layer === "candidate" ? 0.08 : 1;
        const force = (distance - rest) * 0.02 * alpha * layerWeight;
        a.vx += (dx / distance) * force * distance * 0.01;
        a.vy += (dy / distance) * force * distance * 0.01;
        b.vx -= (dx / distance) * force * distance * 0.01;
        b.vy -= (dy / distance) * force * distance * 0.01;
      }
      for (const node of visible) {
        if (node === dragNode) continue;
        node.x += clamp(node.vx, -8, 8);
        node.y += clamp(node.vy, -8, 8);
        node.vx *= 0.85;
        node.vy *= 0.85;
      }
      alpha = alpha < 0.004 ? 0 : alpha * 0.985;
    }

    // ---- drawing ----------------------------------------------------------
    function draw() {
      const { width, height } = canvas.getBoundingClientRect();
      // Cap DPR: full retina resolution quadruples fill cost for no real
      // benefit in a node-link debug view.
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(view.x, view.y);
      ctx.scale(view.k, view.k);

      const activeEdges = visibleEdges();
      // Candidates all share one style: batch them into a single path and
      // stroke once instead of paying per-edge state changes hundreds of
      // times per frame.
      ctx.strokeStyle = "#6e7681";
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (const edge of activeEdges) {
        if (edge.layer !== "candidate") continue;
        ctx.moveTo(edge.sourceNode.x, edge.sourceNode.y);
        ctx.lineTo(edge.targetNode.x, edge.targetNode.y);
      }
      ctx.stroke();

      for (const edge of activeEdges) {
        if (edge.layer === "candidate") continue;
        const { sourceNode: a, targetNode: b } = edge;
        ctx.strokeStyle = edge.color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 0.8 + clamp01(edge.strength) * 2.2;
        ctx.setLineDash(edge.status === "demoted" ? [5, 4] : []);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (edge.direction === "source->target") drawArrow(a, b, edge.color);
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      const visible = visibleNodes();
      const needle = filter.toLowerCase();
      const labelCandidates = [];
      for (const node of visible) {
        const dimmed = needle && !node.name.toLowerCase().includes(needle);
        ctx.globalAlpha = dimmed ? 0.15 : 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, TAU);
        ctx.fillStyle = node.color;
        ctx.fill();
        if (node.degree === 0) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + 3, 0, TAU);
          ctx.strokeStyle = "#d29922";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        if (node === hovered || node === selected) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + 2, 0, TAU);
          ctx.strokeStyle = "#e6edf3";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (!dimmed) labelCandidates.push(node);
      }
      ctx.globalAlpha = 1;
      drawLabels(labelCandidates);
    }

    // Greedy screen-space decluttering: highest-degree nodes keep their
    // labels, colliding lower-degree labels drop out instead of overlapping.
    // Hovered/selected nodes always win.
    function drawLabels(candidates) {
      const placed = [];
      const sorted = [...candidates].sort((left, right) => right.degree - left.degree);
      ctx.fillStyle = "#8b949e";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      for (const node of sorted) {
        const sx = node.x * view.k + view.x;
        const sy = (node.y + node.radius + 13) * view.k + view.y;
        const width = Math.min(node.name.length, 24) * 6.5 * view.k + 24;
        const pinned = node === hovered || node === selected;
        const collides = placed.some(
          (other) =>
            Math.abs(other.x - sx) < (other.w + width) / 2 && Math.abs(other.y - sy) < 14,
        );
        if (collides && !pinned) continue;
        placed.push({ x: sx, y: sy, w: width });
        ctx.fillText(truncate(node.name, 24), node.x, node.y + node.radius + 13);
      }
    }

    function drawArrow(a, b, color) {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const tipX = b.x - Math.cos(angle) * (b.radius + 2);
      const tipY = b.y - Math.sin(angle) * (b.radius + 2);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(
        tipX - Math.cos(angle - 0.45) * 8,
        tipY - Math.sin(angle - 0.45) * 8,
      );
      ctx.lineTo(
        tipX - Math.cos(angle + 0.45) * 8,
        tipY - Math.sin(angle + 0.45) * 8,
      );
      ctx.closePath();
      ctx.fill();
    }

    // ---- picking & interaction -------------------------------------------
    function toWorld(event) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left - view.x) / view.k,
        y: (event.clientY - rect.top - view.y) / view.k,
      };
    }

    function pick(event) {
      const point = toWorld(event);
      let best = null;
      let bestDistance = Infinity;
      for (const node of visibleNodes()) {
        const distance = Math.hypot(node.x - point.x, node.y - point.y);
        if (distance < node.radius + 4 && distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    }

    let panStart = null;
    canvas.addEventListener("mousedown", (event) => {
      autoFit = false;
      const node = pick(event);
      if (node) {
        dragNode = node;
        wake(0.3);
      } else {
        panning = true;
        panStart = { x: event.clientX - view.x, y: event.clientY - view.y };
      }
      canvas.classList.add("dragging");
    });
    window.addEventListener("mouseup", () => {
      dragNode = null;
      panning = false;
      canvas.classList.remove("dragging");
    });
    canvas.addEventListener("mousemove", (event) => {
      if (dragNode) {
        const point = toWorld(event);
        dragNode.x = point.x;
        dragNode.y = point.y;
        dragNode.vx = 0;
        dragNode.vy = 0;
        wake(0.15);
        return;
      }
      if (panning && panStart) {
        view.x = event.clientX - panStart.x;
        view.y = event.clientY - panStart.y;
        wake();
        return;
      }
      hovered = pick(event);
      wake();
      if (hovered) {
        tooltip.style.display = "block";
        tooltip.style.left = `${event.clientX - container.getBoundingClientRect().left + 14}px`;
        tooltip.style.top = `${event.clientY - container.getBoundingClientRect().top + 14}px`;
        tooltip.innerHTML = "";
        const name = document.createElement("div");
        name.className = "name";
        name.textContent = hovered.name;
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${hovered.kind} · ${hovered.memoryCount} memories · degree ${hovered.degree}`;
        tooltip.append(name, meta);
      } else {
        tooltip.style.display = "none";
      }
    });
    canvas.addEventListener("click", (event) => {
      selected = pick(event);
      renderDetail();
      wake();
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        autoFit = false;
        const rect = canvas.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        const k = clamp(view.k * factor, 0.1, 6);
        view.x = mx - ((mx - view.x) / view.k) * k;
        view.y = my - ((my - view.y) / view.k) * k;
        view.k = k;
        wake();
      },
      { passive: false },
    );

    function renderDetail() {
      if (!selected) {
        detail.classList.remove("open");
        return;
      }
      detail.classList.add("open");
      detail.querySelector("h2").textContent = selected.name;
      detail.querySelector(".meta").textContent =
        `${selected.kind} · ${selected.status} · ${selected.residence} · ` +
        `${selected.memoryCount} memories · degree ${selected.degree}`;
      detail.querySelector(".summary").textContent = selected.summary || "";
      const list = detail.querySelector(".statements");
      list.innerHTML = "";
      for (const statement of selected.statements) {
        const item = document.createElement("li");
        item.textContent = statement;
        list.append(item);
      }
    }
    detail.querySelector(".close").addEventListener("click", () => {
      selected = null;
      renderDetail();
    });

    searchInput.addEventListener("input", () => {
      filter = searchInput.value.trim();
      wake();
    });
    hideIsolatedInput.addEventListener("change", () => {
      hideIsolated = hideIsolatedInput.checked;
      wake(0.3);
    });
    window.addEventListener("resize", () => wake());

    // ---- filtering --------------------------------------------------------
    function visibleNodes() {
      return nodes.filter((node) => !(hideIsolated && node.degree === 0));
    }
    function visibleEdges() {
      const visible = new Set(visibleNodes());
      return edges.filter(
        (edge) =>
          !hiddenTypes.has(edge.type) &&
          visible.has(edge.sourceNode) &&
          visible.has(edge.targetNode),
      );
    }

    // ---- stats & framing --------------------------------------------------
    const isolated = nodes.filter((node) => node.degree === 0).length;
    const edgeCount = (layer) => edges.filter((edge) => edge.layer === layer).length;
    stats.textContent =
      `${nodes.length} nodes · ${edgeCount("relation")} relations · ` +
      `${edgeCount("candidate")} candidates · ${edgeCount("supersedes")} supersedes · ` +
      `${isolated} isolated · generated ${data.generatedAt}`;

    // Auto-fit the real node bounds while the layout settles; the first user
    // pan/zoom/drag (or cooldown) hands control over.
    let autoFit = true;
    function fitToBounds() {
      if (nodes.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const node of nodes) {
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x);
        minY = Math.min(minY, node.y);
        maxY = Math.max(maxY, node.y);
      }
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      const k = clamp(
        Math.min(rect.width / (width * 1.15 + 80), rect.height / (height * 1.15 + 80)),
        0.05,
        2,
      );
      view.k = k;
      view.x = rect.width / 2 - ((minX + maxX) / 2) * k;
      view.y = rect.height / 2 - ((minY + maxY) / 2) * k;
    }
    fitToBounds();

    // Event-driven frame loop: physics cools to alpha 0 and the loop shuts
    // down entirely — the page idles at zero cost. Any interaction calls
    // wake(); reheat > 0 also nudges the simulation temperature back up.
    let running = false;
    let destroyed = false;
    function wake(reheat = 0) {
      if (destroyed) return;
      if (reheat > 0 && hasEdges) alpha = Math.max(alpha, reheat);
      if (!running) {
        running = true;
        requestAnimationFrame(frame);
      }
    }
    function frame() {
      if (destroyed) return;
      tick();
      if (autoFit) fitToBounds();
      draw();
      if (alpha > 0) {
        requestAnimationFrame(frame);
      } else {
        running = false;
        autoFit = false;
      }
    }
    wake();

    return {
      destroy() {
        destroyed = true;
        container.innerHTML = "";
      },
      reheat() {
        wake(1);
      },
      view,
    };
  }

  // Deterministic HSL color per string key — same kind/type, same color.
  function hashColor(key, saturation, lightness) {
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) {
      hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
    }
    return `hsl(${hash % 360} ${saturation}% ${lightness}%)`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function clamp01(value) {
    return clamp(value, 0, 1);
  }
  function truncate(value, length) {
    return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
  }

  return { mount };
})();
