(function(exports) {

  // some constants
  var DATA_URL_FORMAT = "https://dap.18f.us/bulk/{source}.json";

  // common parsing and formatting functions
  var formatCommas = d3.format(","),
      parseDate = d3.time.format("%Y-%m-%d").parse,
      formatDate = d3.time.format("%A, %b %e"),
      formatVisits = (function() {
        var suffix = {
          "k": "k",
          "M": "m"
        };
        return function(visits) {
          var prefix = d3.formatPrefix(visits);
          return prefix && suffix.hasOwnProperty(prefix.symbol)
            ? prefix.scale(visits).toFixed(1) + suffix[prefix.symbol]
            : formatCommas(visits);
        };
      })(),
      percent = function(fraction) {
        var pct = fraction * 100;
        return pct > 1
          ? (pct.toFixed(3) + "%")
          : "1px";
      };

  /*
   * Define block renderers for each of the different data types.
   */
  var BLOCKS = {

    // the users block is just `data.totals.visitors` formatted with commas
    "users": renderBlock()
      .render(function(selection, data) {
        selection.text(formatCommas(data.totals.visitors));
      }),

    // the OS block is a stack layout
    "os": renderBlock()
      .transform(function(d) {
        return listify(d.totals.os);
      })
      .render(renderTable()
        .format(formatVisits)
        .column(0, function(column) {
          column.label = "OS";
        })),

    // the windows block is a stack layout
    "windows": renderBlock()
      .transform(function(d) {
        return listify(d.totals.os_version);
      })
      .render(stack()),

    // the devices block is a stack layout
    "devices": renderBlock()
      .transform(function(d) {
        return listify(d.totals.devices);
      })
      .render(renderTable()
        .format(formatVisits)
        .column(0, function(column) {
          column.label = "Form factor";
        })),

    // the browsers block is a table
    "browsers": renderBlock()
      .transform(function(d) {
        return listify(d.totals.browser);
      })
      .render(renderTable()
        .format(formatVisits)
        .column(0, function(column) {
          column.label = "Browser";
        })),

    // the IE block is a stack, but with some extra work done to transform the 
    // data beforehand to match the expected object format
    "ie": renderBlock()
      .transform(function(d) {
        var totals = d3.nest()
          .key(function(d) { return d.browser_version; })
          .rollup(function(d) {
            return d3.sum(d, function(x) { return x.visits; });
          })
          .map(d.data);
        return listify(totals)
          .slice(0, 5);
      })
      .render(stack()),

    // the top pages block(s)
    "top-pages": renderBlock()
      .transform(function(d) {
        return d.data;
      })
      .on("render", function(selection, data) {
        selection.selectAll("td.name")
          .text("")
          .append("a")
            .attr("href", function(d) {
              return "http://" + d.data.domain;
            })
            .text(function(d) { return d.data.domain; });
      })
      .render(renderTable()
        .label(function(d) { return d.domain; })
        .value(function(d) { return +d.visits; })
        .format(formatVisits)
        .column(0, function(column) {
          column.label = "Domain";
        })),

    // the sources block is a table
    "sources": renderBlock()
      .transform(function(d) {
        return d.data.map(function(x) {
          return {
            key: x.source,
            value: +x.visits
          };
        });
      })
      .render(renderTable()
        .format(formatVisits))

  };

  /*
   * Now, initialize all of the blocks by:
   *
   * 1. grabbing their data-block attribute
   * 2. looking up the block id in our `BLOCKS` object, and
   * 3. if a renderer exists, calling it on the selection
   */
  d3.selectAll("*[data-source]")
    .each(function() {
      var blockId = this.getAttribute("data-block"),
          block = BLOCKS[blockId];
      if (!block) {
        return console.warn("no block registered for: %s", blockId);
      }

      d3.select(this)
        .datum({
          source: this.getAttribute("data-source"),
          block: blockId
        })
        .call(block);
    });

  /*
   * A very primitive, aria-based tab system!
   */
  d3.selectAll("*[role='tablist']")
    .each(function() {
      // grab all of the tabs and panels
      var tabs = d3.select(this).selectAll("*[role='tab'][href]")
            .datum(function() {
              var href = this.href,
                  target = document.getElementById(href.split("#").pop());
              return {
                selected: this.getAttribute("aria-selected") === "true",
                target: target
              };
            }),
          panels = d3.select(this.parentNode)
            .selectAll("*[role='tabpanel']");

      // when a tab is clicked, update the panels
      tabs.on("click", function(d) {
        d3.event.preventDefault();
        tabs.each(function(tab) { tab.selected = false; });
        d.selected = true;
        update();
      });

      // update them to start
      update();

      function update() {
        var selected;
        tabs.attr("aria-selected", function(tab) {
          if (tab.selected) selected = tab.target;
          return tab.selected;
        });
        panels.attr("aria-hidden", function(panel) {
          panel.selected = selected === this;
          return !panel.selected;
        })
        .style("display", function(d) {
          return d.selected ? null : "none";
        });
      }
    });

  /*
   * our block renderer is a d3 selection manipulator that does a bunch of
   * stuff:
   *
   * 1. it knows how to get the URL for a block by either looking at the
   *    `source` key of its bound data _or_ the node's data-source attribute.
   * 2. it can be configured to transform the loaded data using a function
   * 3. it has a configurable rendering function that gets called on the first
   *    child of matching the `.data` selector.
   * 4. it dispatches events "loading", "load", "render" and "error" events to
   *    notify us of the state of data.
   *
   * Example:
   *
   * ```js
   * var block = renderBlock()
   *   .render(function(selection, data) {
   *     selection.text(JSON.stringify(data));
   *   });
   * d3.select("#foo")
   *   .call(block);
   * ```
   */
  function renderBlock() {
    var url = function(d) {
          return d && d.source;
        },
        transform = Object,
        renderer = function() { },
        dispatch = d3.dispatch("loading", "load", "error", "render");

    var block = function(selection) {
      selection
        .each(function(d) {
          if (d._request) d._request.abort();

          var that = d3.select(this)
            .classed("loading", true)
            .classed("loaded error", false);

          dispatch.loading(selection, d);

          var json = url.apply(this, arguments);
          if (!json) {
            return console.error("no data source found:", this, d);
          }

          d._request = d3.json(json, function(error, data) {
            that.classed("loading", false);
            if (error) return that.call(onerror, error);

            that.classed("loaded", true);
            dispatch.load(selection, data);
            that.call(render, d._data = transform(data));
          });
        });
    };

    function onerror(selection, request) {
      var message = request.responseText;

      selection.classed("error", true)
        .select(".error-message")
          .text(message);

      dispatch.error(selection, request, message);
    }

    block.render = function(x) {
      if (!arguments.length) return renderer;
      renderer = x;
      return block;
    };

    block.url = function(x) {
      if (!arguments.length) return url;
      url = d3.functor(x);
      return block;
    };

    block.transform = function(x) {
      if (!arguments.length) return transform;
      transform = d3.functor(x);
      return block;
    };

    function render(selection, data) {
      selection.select(".data")
        .datum(data)
        .call(renderer, data);
      dispatch.render(selection, data);
    }

    return d3.rebind(block, dispatch, "on");
  }

  /*
   * This is a tabular data renderer that defaults to a 3-column layout:
   *
   * 1. "Name" -> `label(d)`
   * 2. "Visits" -> `format(value(d))`
   * 3. (chart) -> a `div.bar` with a width corresponding to `value(d) / total`
   *
   * Tables are configurable with the following accessors:
   *
   * - table.rows([setter]): the rows accessor, defaults to identity function
   * - table.label([setter]): the label accessor
   * - table.value([setter]): the numeric value ("Visits") accessor
   * - table.format([setter]): the value formatting function
   * - table.columns([columns]): get or set the column configuration, which
   *   should be an array of objects with the signature:
   *
   *   {label: String, klass: String, value: function}
   *
   * - table.column(index [, column]): get or configure an indexed column,
   *   where `column` may either be an object with the above signature or a
   *   function that takes a column object and modifies it in place.
   */
  function renderTable() {
    var rows = function(d) {
          return d;
        },
        label = function(d) {
          return d.key;
        },
        value = function(d) {
          return +d.value;
        },
        format = String,
        columns = [
          {label: "Name", klass: "name",
            value: function(d) { return label(d); }},
          {label: "Visits", klass: "visits",
            value: function(d) { return format(value(d)); }},
          {label: "", klass: "chart", value: d3.functor("")}
        ];

    var table = function(selection) {
      var thead = element(selection, "thead"),
          tbody = element(selection, "tbody");

      var th = element(thead, "tr")
        .selectAll("th")
          .data(columns);
      th.exit().remove();
      th.enter().append("th");

      th.attr("class", function(d) { return d.klass; })
        .text(function(d) { return d.label; });

      var tr = tbody.selectAll("tr")
        .data(rows);
      tr.exit().remove();
      tr.enter().append("tr");

      var td = tr.selectAll("td")
        .data(function(d) {
          return columns.map(function(column) {
            return {
              column: column,
              data: d,
              value: column.value(d)
            };
          });
        });

      td.exit().remove();

      td.enter().append("td");

      td.attr("class", function(d) {
          return d.column.klass;
        })
        .html(function(d, i) {
          return d.value;
        });

      var bar = element(td.filter(".chart"), "div.bar");
      element(bar, "span.value");

      try {
        var total = d3.sum(tr.data(), value);
      } catch (error) {
        total = 0;
      }
      td.select(".bar")
        .style("width", function(d) {
          d._share = value(d.data) / total;
          return percent(d._share);
        })
        .select(".value")
          .text(function(d) {
            return (d._share * 100).toFixed(1) + "%";
          });
    };

    table.label = function(x) {
      if (!arguments.length) return label;
      label = d3.functor(x);
      return table;
    };

    table.href = function(x) {
      if (!arguments.length) return href;
      href = d3.functor(x);
      return table;
    };

    table.value = function(x) {
      if (!arguments.length) return value;
      value = d3.functor(x);
      return table;
    };

    table.format = function(x) {
      if (!arguments.length) return format;
      format = x;
      return table;
    };

    table.columns = function(x) {
      if (!arguments.length) return columns;
      columns = x;
      return table;
    };

    table.column = function(i, column) {
      if (arguments.length < 2) return columns[i];
      if (typeof column === "function") {
        var out = column(columns[i]);
        columns[i] = out || columns[i];
      } else {
        columns[i] = column;
      }
      return table;
    };

    return table;
  }

  /*
   * listify an Object into its key/value pairs (entries) and sorting by
   * numeric value descending.
   */
  function listify(obj) {
    return d3.entries(obj)
      .sort(function(a, b) {
        return d3.descending(+a.value, +b.value);
      });
  }

  /*
   * TODO: document
   */
  function stack() {
    var bins = function(d) {
          return d;
        },
        value = function(d) {
          return d.value;
        },
        format = String,
        label = function(d) {
          return d.key;
        },
        updated = false;

    var stack = function(selection) {
      var bin = selection.selectAll(".bin")
        .data(bins);

      bin.exit().remove();

      var enter = bin.enter().append("div")
        .attr("class", "bin");
      enter.append("b")
        .attr("class", "label");
      enter.append("span")
        .attr("class", "value");

      var total = d3.sum(bin.data().map(value));
      bin.each(function(d) {
        d._share = value(d) / total;
      });

      var t = updated
        ? bin.transition().duration(500)
        : bin;

      t.style("width", function(d) {
        return percent(d._share);
      });

      bin.select(".label").text(label);
      bin.select(".value").text(function(d) {
        return format(value(d));
      });

      updated = true;
    };

    stack.bins = function(x) {
      if (!arguments.length) return bins;
      bins = d3.functor(x);
      return stack;
    };

    stack.label = function(x) {
      if (!arguments.length) return label;
      label = d3.functor(x);
      return stack;
    };

    stack.value = function(x) {
      if (!arguments.length) return value;
      value = d3.functor(x);
      return stack;
    };

    stack.format = function(x) {
      if (!arguments.length) return format;
      format = d3.functor(x);
      return stack;
    };

    return stack;
  }

  function element(selection, selector) {
    var el = selection.select(selector);
    if (!el.empty()) return el;

    var bits = selector.split("."),
        name = bits[0],
        klass = bits.slice(1).join(" ");
    return selection.append(name)
      .attr("class", klass);
  }

  function addLinks(href) {
    if (!href) href = function(d) { return "http://" + d.domain; };
    return function(selection) {
    };
  }

})(this);