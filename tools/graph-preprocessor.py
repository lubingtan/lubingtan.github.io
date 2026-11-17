#!/usr/bin/env python3
"""mdBook preprocessor: inject a D3.js force-directed graph view as the first chapter."""

import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote

DOCS_DIR = Path('src/docs')
META_FILES = {'index.md', 'log.md'}

PALETTE = [
    '#326ce5', '#4caf50', '#ff9800', '#f44336', '#9c27b0',
    '#00bcd4', '#ff5722', '#607d8b', '#8bc34a', '#e91e63',
    '#3f51b5', '#009688', '#cddc39', '#795548', '#2196f3',
]
DEFAULT_COLOR = '#9e9e9e'


def _assign_colors(categories):
    """Assign colors to categories from the palette, cycling if needed."""
    result = {}
    for i, cat in enumerate(sorted(categories)):
        result[cat] = PALETTE[i % len(PALETTE)]
    return result


def _read_title(filepath):
    """Read the first H1 heading from a file, outside code fences."""
    try:
        with open(filepath) as f:
            in_fence = False
            for line in f:
                s = line.strip()
                if s.startswith('```') or s.startswith('~~~'):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                if s.startswith('# ') and not s.startswith('## '):
                    return s[2:].strip()
    except Exception:
        pass
    return None


def _resolve_link(source_rel, link_target):
    """Resolve a relative link from a source page to a canonical path.

    source_rel: path of the source .md file relative to src/docs/ (e.g. 'Cloud_Native/Kubernetes/kueue')
    link_target: the link target from markdown (e.g. './kubelet原理.md' or '../Linux_Container/容器.md')
    Returns: canonical path relative to src/docs/ (without .md extension), or None if unresolvable
    """
    if not link_target.endswith('.md'):
        return None
    source_dir = os.path.dirname(source_rel)
    resolved = os.path.normpath(os.path.join(source_dir, link_target))
    resolved = resolved.removesuffix('.md')
    # filter out paths that escape docs/ or are empty
    if resolved.startswith('..') or resolved == '.' or not resolved:
        return None
    return resolved


def _category_from_path(rel_path):
    """Extract category label from a relative path like 'Cloud_Native/Kubernetes/kueue'."""
    parts = rel_path.split('/')
    if len(parts) >= 2:
        parent = parts[0].replace('_', ' ')
        sub = parts[1].replace('_', ' ')
        return f'{parent} / {sub}'
    return parts[0].replace('_', ' ')


def _build_graph():
    """Walk src/docs/ and build node/edge lists for the graph.

    Two-pass: first collect all nodes, then resolve edges. This avoids
    ordering issues where a link target hasn't been added to nodes yet.
    """
    nodes = {}
    file_contents = {}
    link_pattern = re.compile(r'\[([^\]]*)\]\(([^)]+)\)')

    # Pass 1: collect all nodes
    for dirpath, _dirnames, filenames in os.walk(DOCS_DIR):
        for fname in filenames:
            if not fname.endswith('.md') or fname in META_FILES:
                continue
            full_path = os.path.join(dirpath, fname)
            rel_path = os.path.relpath(full_path, DOCS_DIR)
            canonical = rel_path.removesuffix('.md')

            title = _read_title(full_path) or os.path.splitext(fname)[0]
            category = _category_from_path(rel_path)

            nodes[canonical] = {
                'id': canonical,
                'name': title,
                'category': category,
                'path': 'docs/' + quote(rel_path.removesuffix('.md') + '.html'),
            }

            with open(full_path) as f:
                file_contents[canonical] = f.read()

    # Pass 2: resolve edges
    edges = []
    for canonical, content in file_contents.items():
        rel_path = canonical + '.md'
        for m in link_pattern.finditer(content):
            target = _resolve_link(rel_path, m.group(2))
            if target and target in nodes:
                edges.append({'source': canonical, 'target': target})

    # count connections for node sizing
    degree = defaultdict(int)
    for e in edges:
        degree[e['source']] += 1
        degree[e['target']] += 1
    for node in nodes.values():
        node['degree'] = degree[node['id']]

    return list(nodes.values()), edges, {n['category'] for n in nodes.values()}


def _graph_html(nodes, edges, categories):
    """Generate the HTML/JS for the graph view page."""
    nodes_json = json.dumps(nodes, ensure_ascii=False)
    edges_json = json.dumps(edges, ensure_ascii=False)
    colors = _assign_colors(categories)
    colors_json = json.dumps(colors, ensure_ascii=False)

    return f'''# Graph View

<div id="graph-container" style="border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;background:#fafafa;"></div>
<div id="graph-legend" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;"></div>

<!-- d3 is vendored under src/assets/ because the d3js.org CDN is unreachable
     on some networks, which left the page blank (same reason mermaid is
     served locally from theme/). -->
<script src="assets/d3.v7.min.js"></script>
<script>
(function() {{
  if (typeof d3 === 'undefined') {{
    document.getElementById('graph-container').textContent =
      'd3.js 加载失败（assets/d3.v7.min.js），关系图无法渲染。';
    return;
  }}
  const nodes = {nodes_json};
  const edges = {edges_json};
  const colors = {colors_json};
  const defaultColor = '{DEFAULT_COLOR}';

  const container = document.getElementById('graph-container');
  const width = container.clientWidth || 800;
  const height = 580;

  // compute radius from degree
  nodes.forEach(d => {{
    d.radius = Math.max(8, Math.min(28, 8 + d.degree * 2.5));
    d.color = colors[d.category] || defaultColor;
  }});

  const svg = d3.select('#graph-container')
    .append('svg')
    .attr('viewBox', [0, 0, width, height])
    .attr('width', width)
    .attr('height', height)
    .attr('style', 'max-width:100%;height:auto;');

  const zoomGroup = svg.append('g');

  // arrow marker
  svg.append('defs').selectAll('marker')
    .data(['arrow'])
    .join('marker')
    .attr('id', 'arrow')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 20)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', '#bbb');

  // Many wiki pages have no cross-links (degree 0). Repulsion alone pushes
  // those isolated nodes ~1000px away, far outside the 748x580 canvas, so
  // only a couple of nodes used to stay visible. Weak springs towards the
  // centre keep every node inside the view.
  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-250))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => d.radius + 4))
    .force('x', d3.forceX(width / 2).strength(0.12))
    .force('y', d3.forceY(height / 2).strength(0.12));

  const link = zoomGroup.append('g')
    .attr('stroke', '#bbb')
    .attr('stroke-opacity', 0.6)
    .attr('stroke-width', 1.2)
    .selectAll('line')
    .data(edges)
    .join('line')
    .attr('marker-end', 'url(#arrow)');

  const node = zoomGroup.append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('r', d => d.radius)
    .attr('fill', d => d.color)
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.5)
    .attr('cursor', 'pointer')
    .on('click', (event, d) => {{
      window.location.href = './' + d.path;
    }});

  const label = zoomGroup.append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .text(d => d.name.length > 12 ? d.name.slice(0, 12) + '…' : d.name)
    .attr('font-size', 10)
    .attr('text-anchor', 'middle')
    .attr('dy', d => -d.radius - 4)
    .attr('fill', '#333')
    .attr('pointer-events', 'none');

  // zoom and pan — keep node/text size readable at all zoom levels
  const zoom = d3.zoom()
    .scaleExtent([0.15, 4])
    .on('zoom', (event) => {{
      zoomGroup.attr('transform', event.transform);
      const k = event.transform.k;
      node.attr('r', d => Math.max(3, d.radius / k));
      node.attr('stroke-width', 1.5 / k);
      label.attr('font-size', Math.max(3, 10 / k) + 'px');
      label.attr('dy', d => (-d.radius / k) - 3);
      link.attr('stroke-width', 1.2 / k);
    }});
  svg.call(zoom);

  // tooltip
  const tooltip = d3.select('body').append('div')
    .style('position', 'absolute')
    .style('padding', '4px 10px')
    .style('background', 'rgba(0,0,0,0.75)')
    .style('color', '#fff')
    .style('border-radius', '4px')
    .style('font-size', '12px')
    .style('pointer-events', 'none')
    .style('opacity', 0)
    .style('z-index', 9999);

  node.on('mouseenter', (event, d) => {{
    tooltip.style('opacity', 1).text(d.name);
  }});
  node.on('mousemove', (event) => {{
    tooltip.style('left', (event.pageX + 10) + 'px')
           .style('top', (event.pageY - 20) + 'px');
  }});
  node.on('mouseleave', () => {{
    tooltip.style('opacity', 0);
  }});

  simulation.on('tick', () => {{
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    node
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);
    label
      .attr('x', d => d.x)
      .attr('y', d => d.y);
  }});

  node.call(d3.drag()
    .on('start', (event, d) => {{
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }})
    .on('drag', (event, d) => {{
      d.fx = event.x;
      d.fy = event.y;
    }})
    .on('end', (event, d) => {{
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }}));

  // legend
  const legend = d3.select('#graph-legend');
  const catEntries = Object.entries(colors);
  catEntries.forEach(([cat, color]) => {{
    const item = legend.append('span')
      .style('display', 'inline-flex')
      .style('align-items', 'center')
      .style('gap', '4px');
    item.append('span')
      .style('display', 'inline-block')
      .style('width', '10px')
      .style('height', '10px')
      .style('border-radius', '50%')
      .style('background', color);
    item.append('span').text(cat);
  }});
  if (catEntries.length === 0) {{
    legend.style('display', 'none');
  }}
}})();
</script>
'''


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'supports':
        sys.exit(0)

    context, book = json.load(sys.stdin)

    nodes, edges, categories = _build_graph()

    # Insert the Graph View right after the 'Latest updates' chapter, which is
    # inserted at the front by blog-preprocessor.py (runs before this one per
    # book.toml preprocessor order). Fall back to the front if not found.
    insert_at = 0
    for i, item in enumerate(book['items']):
        if 'Chapter' in item and item['Chapter'].get('name') == 'Latest updates':
            insert_at = i + 1
            break

    book['items'].insert(insert_at, {
        'Chapter': {
            'name': 'Graph View',
            'content': _graph_html(nodes, edges, categories),
            'sub_items': [],
            'path': 'graph_view.md',
            'source_path': None,
            'parent_names': [],
        }
    })

    print(json.dumps(book, ensure_ascii=False))
