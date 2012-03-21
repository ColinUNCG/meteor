Meteor.ui = Meteor.ui || {};

(function() {

  Meteor.ui.render = function (html_func, react_data, in_range) {
    if (typeof html_func !== "function")
      throw new Error("Meteor.ui.render() requires a function as its first argument.");

    var cx = new Meteor.deps.Context;
    cx.rangeCallbacks = {_count: 0};

    var html = cx.run(html_func);
    if (typeof html !== "string")
      throw new Error("Return value of Meteor.ui.render()'s first argument must be "+
                      "a string");
    var frag = Meteor.ui._htmlToFragment(html);
    if (! frag.firstChild)
      frag.appendChild(document.createComment("empty"));


    var each_comment = function(parent, f) {
      for (var n = parent.firstChild; n;) {
        if (n.nodeType === 8) { // comment
          n = f(n) || n.nextSibling;
          continue;
        } else if (n.nodeType === 1) { // element
          each_comment(n, f);
        }
        n = n.nextSibling;
      }
    };

    // walk comments and create ranges
    var rangeStartNodes = {};
    var rangesCreated = [];
    each_comment(frag, function(n) {
      var next = null;

      n.nodeValue.replace(/^\s*(START|END)RANGE_(\S+)/, function(z, which, id) {
        if (which === "START") {
          if (rangeStartNodes[id])
            throw new Error("Can't render same chunk or range twice.");
          rangeStartNodes[id] = n;
        } else if (which === "END") {
          var startNode = rangeStartNodes[id], endNode = n;

          next = endNode.nextSibling;
          // try to remove comments
          var a = startNode, b = endNode;
          if (a.nextSibling && b.previousSibling) {
            if (a.nextSibling === b) {
              // replace two adjacent comments with one
              endNode = startNode;
              b.parentNode.removeChild(b);
              startNode.nodeValue = 'placeholder';
            } else {
              // remove both comments
              startNode = startNode.nextSibling;
              endNode = endNode.previousSibling;
              a.parentNode.removeChild(a);
              b.parentNode.removeChild(b);
            }
          }

          if (startNode.parentNode !== endNode.parentNode) {
            // Try to fix messed-up comment ranges like
            // <!-- #1 --><tbody> ... <!-- /#1 --></tbody>,
            // which are extremely common with tables.  Tests
            // fail in all browsers without this code.
            if (startNode === endNode.parentNode ||
                startNode === endNode.parentNode.previousSibling) {
              startNode = endNode.parentNode.firstChild;
            } else if (endNode === startNode.parentNode ||
                       endNode === startNode.parentNode.nextSibling) {
              endNode = startNode.parentNode.lastChild;
            } else {
              throw new Error("Could not create liverange in template. "+
                             "Check for unclosed tags in your HTML.");
            }
          }

          var range = new Meteor.ui._LiveUIRange(startNode, endNode);
          // associate the callback with the range temporarily so that
          // we can call all the callbacks in a separate loop.
          range.temp_callback = cx.rangeCallbacks[id];
          rangesCreated.push(range);
        }
      });

      return next;
    });


    var range;
    if (in_range) {
      Meteor.ui._intelligent_replace(in_range, frag);
      range = in_range;
    } else {
      range = new Meteor.ui._LiveUIRange(frag);
    }

    _.each(rangesCreated, function(r) {
      if ("temp_callback" in r) {
        r.temp_callback && r.temp_callback(r);
        delete r.temp_callback;
      }
    });

    Meteor.ui._wire_up(cx, range, html_func, react_data);

    return (in_range ? null : frag);

  };

  Meteor.ui.chunk = function(html_func, react_data) {
    if (typeof html_func !== "function")
      throw new Error("Meteor.ui.chunk() requires a function as its first argument.");

    var parent = Meteor.deps.Context.current;
    var live = parent && parent.rangeCallbacks;

    if (! live) {
      return html_func();
    }

    var cx = new Meteor.deps.Context;
    cx.rangeCallbacks = parent.rangeCallbacks;

    var html = cx.run(html_func);
    if (typeof html !== "string")
      throw new Error("Function passed to chunk() must return a string");

    return Meteor.ui._ranged_html(html, function(range) {
      Meteor.ui._wire_up(cx, range, html_func, react_data);
    });
  };


  Meteor.ui.listChunk = function (observable, doc_func, else_func, react_data) {
    if (typeof doc_func !== "function")
      throw new Error("Meteor.ui.listChunk() requires a function as first argument");
    else_func = (typeof else_func === "function" ? else_func :
                 function() { return ""; });
    react_data = react_data || {};

    var parent = Meteor.deps.Context.current;
    var live = parent && parent.rangeCallbacks;

    var buf = [];
    var receiver = new Meteor.ui._CallbackReceiver();

    var handle = observable.observe(receiver);
    receiver.flush_to_array(buf);

    var doc_render = function(doc) {
      return Meteor.ui._ranged_html(
        Meteor.ui.chunk(function() { return doc_func(doc); },
                        _.extend(react_data, {event_data: doc})));
    };
    var else_render = function() {
      return Meteor.ui.chunk(function() { return else_func(); },
                              react_data);
    };

    var inner_html;
    if (buf.length == 0)
      inner_html = live ? else_render() : else_func();
    else
      inner_html = _.map(buf, live ? doc_render : doc_func).join('');

    if (! live) {
      handle.stop();
      return inner_html;
    }

    return Meteor.ui._ranged_html(inner_html, function(outer_range) {
      var range_list = [];
      // find immediate sub-ranges of range, and add to range_list
      if (buf.length > 0) {
        outer_range.visit(function(is_start, r) {
          if (is_start)
            range_list.push(r);
          return false;
        });
      }

      Meteor.ui._wire_up_list(outer_range, range_list, receiver, handle,
                              doc_func, else_func, react_data);
    });
  };


  // define a subclass of _LiveRange with our tag and a finalize method
  Meteor.ui._LiveUIRange = function(start, end, inner) {
    Meteor.ui._LiveRange.call(this, Meteor.ui._LiveUIRange.tag,
                              start, end, inner);
  };
  Meteor.ui._LiveUIRange.prototype = new (
    _.extend(function() {}, {prototype: Meteor.ui._LiveRange.prototype}));
  Meteor.ui._LiveUIRange.prototype.finalize = function() {
    this.killContext();
  };
  Meteor.ui._LiveUIRange.prototype.killContext = function() {
    var cx = this.context;
    if (cx && ! cx.killed) {
      cx.killed = true;
      cx.invalidate && cx.invalidate();
      delete this.context;
    }
  };
  Meteor.ui._LiveUIRange.tag = "_liveui";

  var _checkOffscreen = function(range) {
    var node = range.firstNode();

    if (node.parentNode &&
        (Meteor.ui._onscreen(node) || Meteor.ui._is_held(node)))
      return false;

    Meteor.ui._LiveRange.cleanup(range);

    return true;
  };

  Meteor.ui._is_held = function(node) {
    while (node.parentNode)
      node = node.parentNode;

    return node.nodeType !== 3 && node._liveui_refs;
  };
  Meteor.ui._hold = function(frag) {
    frag._liveui_refs = (frag._liveui_refs || 0) + 1;
  };
  Meteor.ui._release = function(frag) {
    --frag._liveui_refs;
    if (! frag._liveui_refs) {
      // clean up on flush
      var cx = new Meteor.deps.Context;
      cx.on_invalidate(function() {
        if (! frag._liveui_refs)
          Meteor.ui._LiveRange.cleanup(frag, Meteor.ui._LiveUIRange.tag);
      });
      cx.invalidate();
    }
  };

  Meteor.ui._onscreen = function (node) {
    // http://jsperf.com/is-element-in-the-dom

    if (document.compareDocumentPosition)
      return document.compareDocumentPosition(node) & 16;
    else {
      if (node.nodeType !== 1 /* Element */)
        /* contains() doesn't work reliably on non-Elements. Fine on
         Chrome, not so much on Safari and IE. */
        node = node.parentNode;
      if (node.nodeType === 11 /* DocumentFragment */ ||
          node.nodeType === 9 /* Document */)
        /* contains() chokes on DocumentFragments on IE8 */
        return node === document;
      /* contains() exists on document on Chrome, but only on
       document.body on some other browsers. */
      return document.body.contains(node);
    }
  };

  var CallbackReceiver = function() {
    this.queue = [];
    this.deps = {};
    this.implied_length = 0;

    _.bindAll(this); // make callbacks work even if copied
  };

  Meteor.ui._CallbackReceiver = CallbackReceiver;

  CallbackReceiver.prototype.added = function(doc, before_idx) {
    if (before_idx < 0 || before_idx > this.implied_length)
      throw new Error("Bad before_idx "+before_idx);

    this.implied_length++;
    this.queue.push(['added', doc, before_idx]);
    this.signal();
  };
  CallbackReceiver.prototype.removed = function(id, at_idx) {
    if (at_idx < 0 || at_idx >= this.implied_length)
      throw new Error("Bad at_idx "+at_idx);

    this.implied_length--;
    this.queue.push(['removed', id, at_idx]);
    this.signal();
  };
  CallbackReceiver.prototype.moved = function(doc, old_idx, new_idx) {
    if (old_idx < 0 || old_idx >= this.implied_length)
      throw new Error("Bad old_idx "+old_idx);
    if (new_idx < 0 || new_idx >= this.implied_length)
      throw new Error("Bad new_idx "+new_idx);

    this.queue.push(['moved', doc, old_idx, new_idx]);
    this.signal();
  };
  CallbackReceiver.prototype.changed = function(doc, at_idx) {
    if (at_idx < 0 || at_idx >= this.implied_length)
      throw new Error("Bad at_idx "+at_idx);

    this.queue.push(['changed', doc, at_idx]);
    this.signal();
  };
  CallbackReceiver.prototype.clear = function() {
    this.queue.length = 0;
  };
  CallbackReceiver.prototype.flush_to = function(t) {
    // fire all queued events on new target
    for(var i=0; i<this.queue.length; i++) {
      var a = this.queue[i];
      switch (a[0]) {
      case 'added': t.added(a[1], a[2]); break;
      case 'removed': t.removed(a[1], a[2]); break;
      case 'moved': t.moved(a[1], a[2], a[3]); break;
      case 'changed': t.changed(a[1], a[2]); break;
      }
    }
    this.clear();
  };
  CallbackReceiver.prototype.flush_to_array = function(array) {
    // apply all queued events to array
    for(var i=0; i<this.queue.length; i++) {
      var a = this.queue[i];
      switch (a[0]) {
      case 'added': array.splice(a[2], 0, a[1]); break;
      case 'removed': array.splice(a[2], 1); break;
      case 'moved': array.splice(a[3], 0, array.splice(a[2], 1)[0]); break;
      case 'changed': array[a[2]] = a[1]; break;
      }
    }
    this.clear();
  };
  CallbackReceiver.prototype.signal = function() {
    if (this.queue.length > 0) {
      for(var id in this.deps)
        this.deps[id].invalidate();
    }
  };
  CallbackReceiver.prototype.depend = function() {
    var context = Meteor.deps.Context.current;
    if (context && !(context.id in this.deps)) {
      this.deps[context.id] = context;
      var self = this;
      context.on_invalidate(function() {
        delete self.deps[context.id];
      });
    }
  };

  // XXX jQuery dependency
  // 'event_data' will be an additional argument to event callback
  Meteor.ui._setupEvents = function (elt, events, event_data) {
    events = events || {};
    function create_callback (callback) {
      // return a function that will be used as the jquery event
      // callback, in which "this" is bound to the DOM element bound
      // to the event.
      return function (evt) {
        callback.call(event_data, evt);
      };
    };

    for (var spec in events) {
      var clauses = spec.split(/,\s+/);
      _.each(clauses, function (clause) {
        var parts = clause.split(/\s+/);
        if (parts.length === 0)
          return;

        if (parts.length === 1) {
          $(elt).bind(parts[0], create_callback(events[spec]));
        } else {
          var event = parts.shift();
          var selector = parts.join(' ');
          var callback = create_callback(events[spec]);
          $(elt).delegate(selector, event, callback);
        }
      });
    }
  };


  Meteor.ui._intelligent_replace = function(old_range, new_parent) {

    // Table-body fix:  if old_range is in a table and new_parent
    // contains a TR, wrap fragment in a TBODY on all browsers,
    // so that it will display properly in IE.
    if (old_range.containerNode().nodeName === "TABLE" &&
        _.any(new_parent.childNodes,
              function(n) { return n.nodeName === "TR"; })) {
      var tbody = document.createElement("TBODY");
      while (new_parent.firstChild)
        tbody.appendChild(new_parent.firstChild);
      new_parent.appendChild(tbody);
    }

    var each_labeled_node = function(rangeOrParent, func) {
      var visit_node = function(is_start, node) {
        if (is_start && node.nodeType === 1) {
          if (node.id) {
            func('#'+node.id, node);
          } else if (node.getAttribute("name")) {
            func(node.getAttribute("name"), node);
          } else {
            return true;
          }
          return false; // skip children of labeled node
        }
        return true;
      };

      Meteor.ui._LiveRange.visit_children(rangeOrParent, null, null,
                                          visit_node);
    };

    var patch = function(targetRangeOrParent, sourceNode) {

      var targetNodes = {};
      var targetNodeOrder = {};
      var targetNodeCounter = 0;

      each_labeled_node(targetRangeOrParent, function(label, node) {
        targetNodes[label] = node;
        targetNodeOrder[label] = targetNodeCounter++;
      });

      var patcher = new Meteor.ui._Patcher(
        targetRangeOrParent, sourceNode);
      var lastPos = -1;
      var copyFunc = function(t, s) {
        $(t).unbind(); // XXX remove jquery events from node
        old_range.transplant_tag(t, s);
      };
      each_labeled_node(sourceNode, function(label, node) {
        var tgt = targetNodes[label];
        var src = node;
        if (tgt && targetNodeOrder[label] > lastPos) {
          if (patcher.match(tgt, src, copyFunc)) {
            // match succeeded
            lastPos = targetNodeOrder[label];
            if (tgt.firstChild || src.firstChild)
              patch(tgt, src); // recurse
          }
        }
      });
      patcher.finish();
    };

    //old_range.replace_contents(new_parent);

    old_range.replace_contents(function() {
      Meteor.ui._LiveRange.cleanup(old_range);
      patch(old_range, new_parent);
    });

  };

  Meteor.ui._wire_up = function(cx, range, html_func, react_data) {
    // wire events
    var data = react_data || {};
    if (data.events) {
      for(var n = range.firstNode();
          n && n.previousSibling !== range.lastNode();
          n = n.nextSibling) {
        Meteor.ui._setupEvents(n, data.events, data.event_data);
      }
    }

    if (data.branchName) {
      range.branchName = data.branchName;
    }

    // record that if we see this range offscreen during a flush,
    // we are to kill the context (mark it killed and invalidate it).
    range.killContext();
    range.context = cx;

    // wire update
    cx.on_invalidate(function(old_cx) {
      if (old_cx.killed)
        return; // context was invalidated as part of killing it
      if (_checkOffscreen(range))
        return;

      Meteor.ui.render(html_func, react_data, range);
    });
  };

  Meteor.ui._wire_up_list =
    function(outer_range, range_list, receiver, handle_to_stop,
             doc_func, else_func, react_data)
  {
    react_data = react_data || {};

    outer_range.context = new Meteor.deps.Context;
    outer_range.context.run(function() {
      receiver.depend();
    });
    outer_range.context.on_invalidate(function update(old_cx) {
      if (old_cx.killed) {
        if (handle_to_stop)
          handle_to_stop.stop();
        return;
      }
      if (_checkOffscreen(outer_range))
        return;

      receiver.flush_to(callbacks);

      Meteor.ui._wire_up_list(outer_range, range_list, receiver,
                              handle_to_stop, doc_func, else_func,
                              react_data);
    });

    var makeItem = function(doc, in_range) {
      return Meteor.ui.render(
          _.bind(doc_func, null, doc),
        _.extend(react_data, {event_data: doc}),
        in_range);
    };

    var callbacks = {
      added: function(doc, before_idx) {
        var frag = makeItem(doc);
        var range = new Meteor.ui._LiveUIRange(frag);
        if (range_list.length == 0)
          outer_range.replace_contents(frag);
        else if (before_idx == range_list.length)
          range_list[range_list.length-1].insert_after(frag);
        else
          range_list[before_idx].insert_before(frag);

        range_list.splice(before_idx, 0, range);
      },
      removed: function(doc, at_idx) {
        if (range_list.length == 1)
          outer_range.replace_contents(Meteor.ui.render(
            else_func, react_data));
        else
          range_list[at_idx].extract(false);

        range_list.splice(at_idx, 1);
      },
      moved: function(doc, old_idx, new_idx) {
        if (old_idx == new_idx)
          return;

        var range = range_list[old_idx];
        var frag = range.extract(true);
        range_list.splice(old_idx, 1);

        if (new_idx == range_list.length)
          range_list[range_list.length-1].insert_after(frag);
        else
          range_list[new_idx].insert_before(frag);
        range_list.splice(new_idx, 0, range);
      },
      changed: function(doc, at_idx) {
        var range = range_list[at_idx];

        // replace the render in the immediately nested range
        range.visit(function(is_start, r) {
          if (is_start)
            makeItem(doc, r);
          return false;
        });
      }
    };
  };

  Meteor.ui._ranged_html = function(html, callback) {
    var cx = Meteor.deps.Context.current;
    var ranges = cx && cx.rangeCallbacks;

    if (! ranges)
      return html;

    var commentId = ++ranges._count;
    ranges[commentId] = callback;
    return "<!-- STARTRANGE_"+commentId+" -->" + html +
      "<!-- ENDRANGE_"+commentId+" -->";
  };

})();
