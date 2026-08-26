# AgentPatchCheck Batch 1 Benchmark Manifest

Status: frozen

This set contains only tasks that passed the Fixture Feasibility Gate. No Agent
run, Provider call, TaskSpec construction, Oracle construction, or success-rate
measurement is included in this manifest.

## B1-T1 — sympy/sympy #24562

- repository: sympy/sympy
- remote: https://github.com/sympy/sympy.git
- issue / PR: #24562
- base commit: b1cb676cf92dd1a48365b731979833375b188bf2
- fix commit: c25ecf0ef7c63ec8b9cb416544a682c758fcc5f2
- bug category: numeric normalization
- production files changed: sympy/core/numbers.py
- fixture status: FEASIBLE
- minimal reproduction:
  ~~~python
  from sympy import Rational

  x = Rational("0.5", "100")
  print(x)
  print(x == Rational(1, 200))
  ~~~
- verified base result: 1/100100, equality False
- verified fix result: 1/200, equality True
- targeted test: sympy/core/tests/test_numbers.py::test_Rational_new
- fix regression test: sympy/core/tests/test_numbers.py::test_issue_24543
- environment dependency: Python 3.12.3; mpmath 1.4.1
- oracle requirement: compare the deterministic reproduction result with the
  known correct fix-side result 1/200; no Agent behavior is prescribed.

## B1-T2 — sympy/sympy #24661

- repository: sympy/sympy
- remote: https://github.com/sympy/sympy.git
- issue / PR: #24661
- base commit: a36caf5c74fe654cedc488e8a8a05fad388f8406
- fix commit: 9a1de69bf68064a304cc2c0e7e5328647be5ebd0
- bug category: parser evaluate semantics
- production files changed: sympy/parsing/sympy_parser.py
- fixture status: FEASIBLE
- minimal reproduction:
  ~~~python
  from sympy.parsing.sympy_parser import parse_expr

  x = parse_expr("1 < 2", evaluate=False)
  print(x)
  print(type(x))
  ~~~
- verified base result: True, type BooleanTrue
- verified fix result: 1 < 2, type StrictLessThan
- targeted test: sympy/parsing/tests/test_sympy_parser.py::test_issue_24288
- environment dependency: Python 3.12.3; existing mpmath 1.4.1
- oracle requirement: compare the deterministic expression type/value with the
  fix-side unevaluated relational result; no Agent behavior is prescribed.

## B1-T3 — django/django #16485

- repository: django/django
- remote: https://github.com/django/django.git
- issue / PR: #16485
- base commit: 39f83765e12b0e5d260b7939fc3fe281d879b279
- fix commit: 4b066bde692078b194709d517b27e55defae787c
- bug category: template filter boundary
- production files changed: django/template/defaultfilters.py
- fixture status: FEASIBLE
- minimal reproduction:
  ~~~python
  from django.conf import settings
  settings.configure(USE_I18N=False)

  from django.template.defaultfilters import floatformat
  print(floatformat("0.00", 0))
  ~~~
- verified base result: raises ValueError
- verified fix result: "0"
- targeted test: tests/runtests.py template_tests.filter_tests.test_floatformat
- targeted test result: base and fix each passed 10 tests
- environment dependency: Python 3.12.3; asgiref 3.12.1; sqlparse 0.6.0; minimal USE_I18N=False settings
- oracle requirement: require the deterministic boundary call to return "0"
  without an exception; no Agent behavior is prescribed.

## B1-T4 — sympy/sympy #24539

- repository: sympy/sympy
- remote: https://github.com/sympy/sympy.git
- issue / PR: #24539
- base commit: 193e3825645d93c73e31cdceb6d742cc6919624d
- fix commit: 3450b7573138badc277b238118d088b7d842594a
- bug category: symbol propagation / argument handling
- production files changed: sympy/polys/rings.py
- fixture status: FEASIBLE
- minimal reproduction:
  ~~~python
  from sympy import symbols
  from sympy.polys.domains import ZZ
  from sympy.polys.rings import ring

  R, x, y, z = ring("x,y,z", ZZ)
  f = 3*x**2*y - x*y*z + 7*z**3 + 1
  U, V, W = symbols("u,v,w")
  result = f.as_expr(U, V, W)
  print(result)
  print(result.free_symbols == {U, V, W})
  ~~~
- verified base result: uses ring symbols x, y, z; symbol comparison False
- verified fix result: uses passed symbols u, v, w; symbol comparison True
- targeted test: sympy/polys/tests/test_rings.py::test_PolyElement_as_expr
- targeted test result: base and fix each passed 1 test
- environment dependency: Python 3.12.3; existing mpmath 1.4.1
- oracle requirement: compare the returned expression's free symbols with the
  explicitly passed symbols; no Agent behavior is prescribed.

## Freeze criteria

- B1-T1, B1-T2, B1-T3, and B1-T4 are marked FEASIBLE.
- Every listed base and fix SHA is present as a commit object and was verified
  with git cat-file -e <sha>^{commit} and exact git show --no-patch --format=%H
  <sha> output.
- Each task has a deterministic base/fix distinction and a recorded targeted
  upstream test or targeted direct behavior check.
- No task entry contains Agent success rates, model capability judgments, or
  conclusions about Agent behavior.
- This freeze does not authorize AgentPatchCheck execution, Provider calls,
  TaskSpec/Oracle construction, or Harness changes.
