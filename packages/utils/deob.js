const parser = require('@babel/parser')
const traverse = require('@babel/traverse').default
const t = require('@babel/types')
const generator = require('@babel/generator').default
const fs = require('node:fs/promises')
const path = require('node:path')
const { deepClone } = require('lodash')

let objectVariables = []

class Deob {
  /**
   *
   * @constructor
   * @param {string} rawCode - 原始代码
   * @param {object} [options] -  选项
   * @param {string} [options.dir='./'] - 输出目录
   * @param {boolean} [options.isWriteFile=false] 
   * @param {object} [options.opts] - 是否写入文件
   * @throws {Error} 请载入js代码
   */
  constructor(rawCode, options = {}) {
    if (!rawCode) throw new Error('请载入js代码')
    console.time('useTime')

    /**
     * The raw JavaScript code.
     * @type {string}
     */
    this.rawCode = rawCode

    this.opts = options.opts || {
      minified: false,
      jsescOption: { minimal: true },
      compact: false,
      comments: true,
    }

    this.dir = options.dir ?? './'
    this.isWriteFile = options.isWriteFile ?? false

    this.ast = parser.parse(rawCode, { sourceType: 'script' })
  }

  get code() {
    let code = generator(this.ast, this.opts).code
    return code
  }

  getCode(opts) {
    let code = generator(this.ast, opts || this.opts).code
    console.timeEnd('useTime')
    return code
  }

  /**
   * @description 再次解析重新生成新的ast
   */
  reParse() {
    let jscode = generator(this.ast, this.opts).code

    this.ast = parser.parse(jscode, { sourceType: 'script' })
  }

  /**
   * @description 记录解析后生成的代码 方便调试查看
   * @param {String} fileName
   * @param {Number} i
   */
  async record(fileName, i) {
    if (this.isWriteFile) {
      try {
        await fs.writeFile(
          path.join(this.dir, `${fileName}_${i}.js`),
          this.code,
        )
        console.log(`${fileName}_${i}.js 写入成功`)
      } catch (error) {}
    }
  }

  /**
   * @description 输出成好看形式 用于对比
   */
  async prettierCode() {
    let newCode = generator(this.ast, {
      minified: false,
      jsescOption: { minimal: true },
      compact: false,
      comments: true,
    }).code
    await fs.writeFile(path.join(this.dir, 'pretty.js'), newCode)
  }

  /**
   * 分离多个 var 赋值
   * @example var a = 1, b = 2;  ---> var a = 1; var b = 2;
   */
  splitMultipleDeclarations() {
    traverse(this.ast, {
      VariableDeclaration(path) {
        const declarations = path.node.declarations

        if (declarations.length > 1) {
          const newDeclarations = declarations.map((declaration) => {
            return t.variableDeclaration(path.node.kind, [declaration])
          })

          path.replaceWithMultiple(newDeclarations)
        }
      },
    })
    this.reParse()
  }

  /**
   * @description 执行解密替换
   * @example _0x4698(_0x13ee81, _0x3dfa50) ---> 原始字符串
   */
  decryptReplace(ast, decryptFnCode, decryptFnList, arrayName = '') {
    if (!decryptFnCode) {
      console.log('无解密函数,已跳过')
      return
    }

    // 执行解密函数的代码，这样就可以在 nodejs 中运行解密函数来还原数据
    try {
      console.log(`大数组名为: ${arrayName} `)
      console.log(`解密函数为: ${decryptFnList.join(',')}`)
      console.log(`解密函数代码为: ${decryptFnCode}`)
      const result = global.eval(decryptFnCode)
      console.log('解密函数执行结果:', result)
    } catch (e) {
      throw new Error('解密函数无法 eval 运行')
    }

    /**
     * 执行数组乱序与解密函数代码并将混淆字符串数值还原
     *
     */
    const visitor_decString = {
      // 解密函数可能是 var _0x3e22 = function(){ } 或 function _0x3e22(){}
      'VariableDeclarator|FunctionDeclaration'(path) {
        if (decryptFnList.includes(path.node.id.name)) {
          // 有可能存在多个解密函数，所以需要多次遍历
          const decryptFn = decryptFnList.find((f) => f === path.node.id.name)
          if (!decryptFn) return

          const binding = path.scope.getBinding(decryptFn)

          // 通过作用域来定位
          binding?.referencePaths.forEach((p) => {
            if (!p.parentPath.isCallExpression()) return

            try {
              // 如果调用解密函数中有变量参数则不替换
              const hasIdentifier = p.parentPath.node.arguments.some((a) =>
                t.isIdentifier(a),
              )
              if (hasIdentifier) return

              // 执行 _0x4698(_0x13ee81, _0x3dfa50) 代码, 并替换原始位置
              const callCode = p.parentPath.toString()

              const decStr = eval(callCode)
              console.log(callCode, decStr)

              p.parentPath.replaceWith(t.stringLiteral(decStr))
            } catch (error) {
              // 解密失败 则添加注释 失败原因可能是该函数未调用
              p.addComment('leading', `解密失败${error.message}`, true)
            }
          })
        }
      },
    }

    traverse(ast, visitor_decString)

    this.reParse() // 切记一定要在替换后执行, 因为替换后此时 ast 并未更新, 就可能会导致后续处理都使用原先的 ast
  }

  /**
   * @description 根据函数调用次数寻找到解密函数 并执行解密操作
   * @param {*} count 解密函数调用次数
   * @param {*} isRemove 是否移除解密函数(后续用不到)
   */
  findDecryptFnByCallCount(count = 100, isRemove = false) {
    let decryptFnList = []
    let index = 0 // 定义解密函数所在语句下标

    // 先遍历所有函数(作用域在Program)，并根据引用次数来判断是否为解密函数
    traverse(this.ast, {
      Program(p) {
        p.traverse({
          'FunctionDeclaration|VariableDeclarator'(path) {
            if (
              !(
                t.isFunctionDeclaration(path.node) ||
                t.isFunctionExpression(path.node.init)
              )
            ) {
              return
            }

            let name = path.node.id.name
            let binding = path.scope.getBinding(name)
            if (!binding) return

            if (binding.referencePaths.length > count) {
              decryptFnList.push(name)

              // 根据最后一个解密函数来定义解密函数所在语句下标
              let binding = p.scope.getBinding(name)
              if (!binding) return

              let parent = binding.path.find(
                (p) => p.isFunctionDeclaration() || p.isVariableDeclaration(),
              )
              if (!parent) return
              let body = p.scope.block.body
              for (let i = 0; i < body.length; i++) {
                const node = body[i]
                if (node.start == parent.node.start) {
                  index = i + 1
                }
              }
              // 遍历完当前节点,就不再往子节点遍历
              path.skip()
            }
          },
        })
      },
    })

    let descryptAst = parser.parse('')
    // 插入解密函数前的几条语句
    descryptAst.program.body = this.ast.program.body.slice(0, index)
    // 把这部分的代码转为字符串，由于可能存在格式化检测，需要指定选项，来压缩代码
    let decryptFnCode = generator(descryptAst, { compact: true }).code

    this.decryptReplace(this.ast, decryptFnCode, decryptFnList)

    if (isRemove) {
      this.ast.program.body = this.ast.program.body.slice(index)
    }
  }

  /**
   * @description 指明解密函数,会将解密函数以上的代码注入执行
   * @param {string[]} decryptFnList 多个解密函数名
   * @param {*} isRemove 是否移除解密函数(后续用不到)
   */
  designDecryptFn(decryptFnList, isRemove = false) {
    if (!Array.isArray(decryptFnList)) {
      decryptFnList = [decryptFnList]
    }

    let index = 0 // 定义解密函数所在语句下标

    traverse(this.ast, {
      Program(p) {
        p.traverse({
          'FunctionDeclaration|VariableDeclarator'(path) {
            if (
              !(
                t.isFunctionDeclaration(path.node) ||
                t.isFunctionExpression(path.node.init)
              )
            ) {
              return
            }

            let name = path.node.id.name

            if (!decryptFnList.includes(name)) {
              return
            }

            // 根据最后一个解密函数来定义解密函数所在语句下标
            let binding = p.scope.getBinding(name)
            if (!binding) return

            let parent = binding.path.find(
              (p) => p.isFunctionDeclaration() || p.isVariableDeclaration(),
            )
            if (!parent) return
            let body = p.scope.block.body
            for (let i = 0; i < body.length; i++) {
              const node = body[i]
              if (node.start == parent.node.start) {
                index = i + 1
              }
            }
            // 遍历完当前节点,就不再往子节点遍历
            path.skip()
          },
        })
      },
    })

    let descryptAst = parser.parse('')
    descryptAst.program.body = this.ast.program.body.slice(0, index)
    // 把这部分的代码转为字符串，由于可能存在格式化检测，需要指定选项，来压缩代码
    let decryptFnCode = generator(descryptAst, { compact: true }).code

    this.decryptReplace(this.ast, decryptFnCode, decryptFnList)

    if (isRemove) {
      this.ast.program.body = this.ast.program.body.slice(index)
    }

    this.reParse() // 切记一定要在替换后执行, 因为替换后此时 ast 并未更新, 就可能会导致后续处理都使用原先的 ast
  }

  /**
   * @description 输入解密函数代码
   */
  InjectDecryptFnCode(decryptFnCode) {}

  /**
     * @description 嵌套函数花指令替换
     * @deprecated
     * @example	
     *  _0x4698 为解密函数
     *  var _0x49afe4 = function (_0x254ae1, _0x559602, _0x3dfa50, _0x21855f, _0x13ee81) {
            return _0x4698(_0x13ee81 - -674, _0x3dfa50);
        }; 
        ⬇️ 
        _0x49afe4(-57, 1080, 828, 1138, 469) ---> _0x4698(_0x13ee81 - -674, _0x3dfa50) 
        _0x4698('469' - -674, '828') ---> 调用解密函数得到原字符串
     */
  nestedFnReplace() {
    let decryptFnList = this.decryptFnList
    if (decryptFnList.length === 0) return

    traverse(this.ast, {
      VariableDeclarator(path) {
        if (decryptFnList.includes(path.node.id.name)) {
          let decryptFuncName = decryptFnList.find(
            (f) => f === path.node.id.name,
          )
          let binding_decFunc = path.scope.getBinding(decryptFuncName)
          binding_decFunc &&
            binding_decFunc.referencePaths.map((p_dec) => {
              if (
                !(
                  p_dec.parentPath.isCallExpression() &&
                  p_dec.parentPath.node.arguments.length === 2
                )
              )
                return
              // 寻找嵌套函数 剔除多次调用无用的花指令
              // var _0x1b0063 = function(_0x3b85ee, _0x422ba8, _0x399819, _0x41dc9e, _0x14fe2f) {
              //    return _0x4698(_0x41dc9e - -0x2d1, _0x422ba8);
              // };
              // 不是return语句,则判断不是解密函数花指令
              if (!p_dec.parentPath.parentPath.isReturnStatement()) return
              let callFuncVarPath = p_dec.findParent(
                (p) => p.node.type === 'VariableDeclarator',
              )

              let callFuncName = callFuncVarPath.node.id.name
              let orgcallFuncInit = deepClone(callFuncVarPath.node.init) // 用于后续重命名还原原始函数

              // 获取嵌套函数的binding 在根据嵌套函数的作用域referencePaths 遍历调用嵌套函数的地方
              let binding_callFunc = p_dec.scope.getBinding(callFuncName)
              binding_callFunc &&
                binding_callFunc.referencePaths.map((p_call) => {
                  // 获取实参
                  let argumentList = p_call.parentPath.node.arguments
                  let orgArgumentList = deepClone(argumentList)
                  let params = callFuncVarPath.node.init.params
                  let orgParams = deepClone(params)
                  // 实参中如果有变量则直接跳出不替换
                  let hasIdentifier = orgArgumentList.some((a) =>
                    t.isIdentifier(a),
                  )
                  if (hasIdentifier) return

                  let nameMap = {}
                  // 实参有可能小于形参 所以遍历实参
                  for (let i = 0; i < orgArgumentList.length; i++) {
                    let paramName = orgParams[i].name
                    let argumentName

                    if (orgArgumentList[i].type === 'UnaryExpression') {
                      argumentName =
                        orgArgumentList[i].operator +
                        orgArgumentList[i].argument.value
                    } else {
                      argumentName = orgArgumentList[i].value
                    }
                    argumentName = `'${argumentName}'`
                    // 将形参变为传入的实参 并指定作用域为嵌套函数内
                    p_dec.parentPath.scope.rename(paramName, argumentName)
                    nameMap[paramName] = argumentName
                  }
                  // if (callFuncName === '_0x262585') {
                  //   console.log(orgParams.map((p) => p.name));
                  //   console.log(orgArgumentList.map((p) => p.value));

                  //   console.log(p_call.parentPath.toString());
                  //   console.log(p_dec.parentPath.toString());
                  // }

                  // 将形参都转为实参后 然后生成对应解密后的代码 直接替换原本调用嵌套函数的地方 后面解密函数要处理
                  let code = p_dec.parentPath.toString()
                  p_call.parentPath.replaceWithSourceString(code)

                  // 然后重命名回来
                  Object.entries(nameMap).map((o) => {
                    let paramName = o[0]
                    let argumentName = o[1]
                    p_dec.parentPath.scope.rename(argumentName, paramName)
                  })

                  /* 重命名后此时内嵌函数将会变成
                                      _0x49afe4 = function ('-57', '1080', '828', '1138', '469') {
                                        return _0x4698('469' - -674, '828');
                                      }' 
                                    但形参不能为字面量,所以就需要转化成原先的参数
                                    */
                  callFuncVarPath.node.init = orgcallFuncInit

                  // p_call.parentPath.toString()
                  // '_0x49afe4(-57, 1080, 828, 1138, 469)'
                  // p_dec.parentPath.toString()
                  // '_0x4698(_0x13ee81 - -674, _0x3dfa50)'
                  // funcVarPath.toString()
                  // _0x49afe4 = function ('-57', '1080', '828', '1138', '469') {
                  //   return _0x4698('469' - -0x2a2, '828');
                  // }
                })
            })
        }
      },
    })
  }

  /**
   * @description 保存所有对象 用于后续替换
   * @example
   * var _0x52627b = {
   *  'QqaUY': "attribute",
   *  'SDgrw': function (_0x45e680) {
   *    return _0x45e680();
   *  },
   *  'GOEUR': function (_0xeaa58e, _0x247ba7) {
   *    return _0xeaa58e + _0x247ba7;
   *  }
   */
  saveAllObject() {
    objectVariables = []
    traverse(this.ast, {
      VariableDeclaration(path) {
        path.node.declarations.forEach((declaration) => {
          if (declaration.id.type === 'Identifier') {
            const variableName = declaration.id.name

            if (declaration.init?.type === 'ObjectExpression') {
              objectVariables[variableName] = declaration.init
            }
          }
        })
      },
    })

    console.log(`已保存所有对象`)
  }

  /**
   * @description 对象属性替换  前提需要执行 saveAllObjectect 用于保存所有变量
   * @example
   * var _0x52627b = {
   *  'QqaUY': "attribute",
   *  'SDgrw': function (_0x45e680) {
   *     return _0x45e680();
   *   },
   *   'GOEUR': function (_0xeaa58e, _0x247ba7) {
   *     return _0xeaa58e + _0x247ba7;
   *   }
   * }
   * 🔽
   * _0x52627b["QqaUY"] ---> "attribute"
   * _0x52627b["SDgrw"](_0x4547db) ---> _0x4547db()
   * _0x52627b["GOEUR"](a, b) ---> a + b
   */
  objectMemberReplace() {
    // 先执行 _0x52627b["QqaUY"] ---> "attribute"
    traverse(this.ast, {
      MemberExpression(path) {
        // // 父级表达式不能是赋值语句
        let asignment = path.parentPath
        if (!asignment || asignment?.type === 'AssignmentExpression') return

        if (
          path.node.object.type === 'Identifier' &&
          (path.node.property.type === 'StringLiteral' ||
            path.node.property.type === 'Identifier')
        ) {
          const objectName = path.node.object.name

          //    xxx            obj['xxx']                  obj.xxx
          const propertyName =
            path.node.property.value || path.node.property.name

          if (objectVariables[objectName]) {
            const objectInit = objectVariables[objectName]

            const properties = objectInit.properties
            for (const prop of properties) {
              const keyName = prop.key.value || prop.key.name
              if (
                (prop.key.type === 'StringLiteral' ||
                  prop.key.type === 'Identifier') &&
                keyName === propertyName &&
                t.isLiteral(prop.value)
              ) {
                // 还需要判断 objectName[propertyName] 是否被修改过
                let binding = path.scope.getBinding(objectName)
                if (
                  binding &&
                  binding.constant &&
                  binding.constantViolations.length == 0
                ) {
                  console.log(objectName, propertyName)

                  path.replaceWith(prop.value)
                }
              }
            }
          }
        }
      },
    })

    // 在执行
    // _0x52627b["GOEUR"](a, b) ---> a + b
    // _0x52627b["SDgrw"](_0x4547db) ---> _0x4547db()
    traverse(this.ast, {
      CallExpression(path) {
        if (
          path.node.callee.type === 'MemberExpression' &&
          path.node.callee.object.type === 'Identifier'
        ) {
          const objectName = path.node.callee.object.name
          const propertyName =
            path.node.callee.property.value || path.node.callee.property.name

          if (objectVariables[objectName]) {
            const objectInit = objectVariables[objectName]

            const properties = objectInit.properties

            // 实际传递参数
            const argumentList = path.node.arguments

            for (const prop of properties) {
              const keyName = prop.key.value || prop.key.name
              if (
                (prop.key.type === 'StringLiteral' ||
                  prop.key.type === 'Identifier') &&
                prop.value.type === 'FunctionExpression' &&
                keyName === propertyName
              ) {
                // 拿到定义函数
                let orgFn = prop.value

                // 在原代码中，函数体就一行 return 语句，取出其中的 argument 属性与调用节点替换
                const firstStatement = orgFn.body.body?.[0]
                if (!(firstStatement?.type === 'ReturnStatement')) return

                console.log(objectName, propertyName)

                // 返回参数
                let returnArgument = firstStatement.argument

                if (t.isBinaryExpression(returnArgument)) {
                  // _0x5a2810 + _0x2b32f4
                  let binaryExpression = t.binaryExpression(
                    returnArgument.operator,
                    argumentList[0],
                    argumentList[1],
                  )
                  path.replaceWith(binaryExpression)
                } else if (t.isLogicalExpression(returnArgument)) {
                  // _0x5a2810 || _0x2b32f4
                  let logicalExpression = t.logicalExpression(
                    returnArgument.operator,
                    argumentList[0],
                    argumentList[1],
                  )
                  path.replaceWith(logicalExpression)
                } else if (t.isUnaryExpression(returnArgument)) {
                  // !_0x5a2810
                  let unaryExpression = t.unaryExpression(
                    returnArgument.operator,
                    argumentList[0],
                  )
                  path.replaceWith(unaryExpression)
                } else if (t.isCallExpression(returnArgument)) {
                  // function (_0x1d0a4d, _0x1df411) {
                  //   return _0x1d0a4d();
                  // }

                  // 取出是哪个参数作为函数名来调用 因为可能会传递多个参数，取其中一个或几个
                  // 确保调用函数名必须是标识符才替换
                  if (returnArgument.callee.type !== 'Identifier') return

                  let callFnName = returnArgument.callee.name // 形参的函数名

                  // 找到从传递的多个参数中 定位索引
                  let callIndex = orgFn.params.findIndex(
                    (a) => a.name === callFnName,
                  )

                  // 再从实际参数(实参)中找到真正函数名
                  let realFnName = argumentList.splice(callIndex, 1)[0]
                  let callExpression = t.callExpression(
                    realFnName,
                    argumentList,
                  )
                  path.replaceWith(callExpression)
                }
              }
            }
          }
        }
      },
    })

    this.reParse()
  }

  /**
     * @description 自调用函数执行并替换
     * @example 
     * ;(function (_0x4f0d08) {
         return function (_0x4f0d08) {
           return Function("Function(arguments[0]+\"" + _0x4f0d08 + "\")()");
         }(_0x4f0d08);
       })("bugger")("de");
       🔽
       Function("Function(arguments[0]+\"" + "bugger" + "\")()")("de")
     */
  selfCallFnReplace() {
    traverse(this.ast, {
      CallExpression(path) {
        if (t.isFunctionExpression(path.node.callee)) {
          // 找到 return 语句
          const firstStatement = path.node.callee.body.body?.[0]
          if (!(firstStatement?.type === 'ReturnStatement')) return

          // ['bugger']
          const outerArguments = path.node.arguments

          // function (_0x4f0d08) { return xxx }(_0x4f0d08)
          const innerFunction = firstStatement.argument

          // [_0x4f0d08]
          const innerArguments = innerFunction.arguments

          // 还需要根据传递的参数 将 _0x4f0d08 改成 bugger
          innerArguments.forEach((argument, index) => {
            path
              .get('callee')
              .get('body')
              .get('body')[0]
              .get('argument')
              .get('callee')
              .traverse({
                Identifier(p) {
                  if (
                    p.parentKey !== 'params' &&
                    p.node.name === argument.name
                  ) {
                    p.replaceWith(outerArguments[index])
                  }
                },
              })
          })

          if (
            t.isCallExpression(innerFunction) &&
            innerFunction.arguments.length === 1
          ) {
            const firstStatement = innerFunction.callee.body?.body?.[0]
            if (!(firstStatement?.type === 'ReturnStatement')) return

            // Function("Function(arguments[0]+\"" + _0x4f0d08 + "\")()");
            const finalExpression = firstStatement.argument

            if (finalExpression.type === 'CallExpression') {
              path.replaceWith(finalExpression)
            }

            path.skip()
          }
        }
      },
    })
  }

  /**
     * @description switch 混淆扁平化 
     * @example 
     * function a() {
         var _0x263cfa = "1|3|2|0"["split"]("|"),
           _0x105b9b = 0;
     
         while (true) {
           switch (_0x263cfa[_0x105b9b++]) {
             case "0":
               return _0x4b70fb;
     
             case "1":
               if (_0x3d66ff !== "link" && _0x3d66ff !== "script") {
                 return;
               }
     
               continue;
     
             case "2":
               _0x4b70fb["charset"] = "utf-8";
               continue;
     
             case "3":
               var _0x4b70fb = document["createElement"](_0x3d66ff);
     
               continue;
           }
     
           break;
         }
       } 
       ⬇️
       function a(){
          if (_0x3d66ff !== "link" && _0x3d66ff !== "script") {
            return;
          }
          var _0x4b70fb = document["createElement"](_0x3d66ff);
          _0x4b70fb["charset"] = "utf-8";
          return _0x4b70fb;
       }
     */
  switchFlat() {
    traverse(this.ast, {
      SwitchStatement(path) {
        // 判断父节点是否为循环节点
        let forOrWhileStatementPath = path.findParent(
          (p) => p.isForStatement() || p.isWhileStatement(),
        )
        if (!forOrWhileStatementPath) return

        // 拿到函数的块语句
        let fnBlockStatementPath = forOrWhileStatementPath.findParent((p) =>
          p.isBlockStatement(),
        )

        let shufferString = ''
        let shufferArr = []

        // 从整个函数的 BlockStatement 中遍历寻找 "1|3|2|0"["split"]
        fnBlockStatementPath.traverse({
          MemberExpression(path) {
            if (
              t.isStringLiteral(path.node.property) &&
              path.node.property.value === 'split'
            ) {
              if (t.isStringLiteral(path.node.object)) {
                // path.node.object.value 为 "1|3|2|0"
                shufferString = path.node.object.value
                shufferArr = shufferString.split('|')

                // 顺带移除 var _0x263cfa = "1|3|2|0"["split"]("|"),
                const VariableDeclarator = path.findParent((p) =>
                  p.isVariableDeclarator(),
                )
                if (VariableDeclarator) VariableDeclarator.remove()

                path.stop()
              }
            }
          },
        })

        if (shufferArr.length === 0) return

        console.log(`switch 平坦化: ${shufferString}`)

        const myArr = path.node.cases
          .filter((p) => p.test?.type === 'StringLiteral')
          .map((p) => p.consequent[0])

        const sequences = shufferArr.map((v) => myArr[v])
        fnBlockStatementPath.node.body.push(...sequences)

        // 将整个 while 循环体都移除
        path.parentPath.parentPath.remove()
        path.skip()
      },
    })
  }

  /**
   * @description 将形参中所包含的对象的改为实参形式
   * @deprecated
   */
  convParam() {
    traverse(this.ast, {
      ExpressionStatement(path) {
        var node = path.node
        if (!t.isCallExpression(node.expression)) return
        if (
          node.expression.arguments == undefined ||
          node.expression.callee.params == undefined ||
          node.expression.arguments.length >
            node.expression.callee.params.length
        )
          return

        // 获取形参和实参
        var argumentList = node.expression.arguments
        var paramList = node.expression.callee.params
        // 实参可能会比形参少，所以我们对实参进行遍历， 查看当前作用域内是否有该实参的引用
        for (var i = 0; i < argumentList.length; i++) {
          var argumentName = argumentList[i].name
          var paramName = paramList[i].name
          path.traverse({
            MemberExpression(_path) {
              var _node = _path.node
              if (
                !t.isIdentifier(_node.object) ||
                _node.object.name !== paramName
              )
                return
              // 有对实参的引用则 将形参的名字改为实参的名字
              _node.object.name = argumentName
            },
          })
        }
        // 删除实参和形参的列表。
        // node.expression.arguments.length = 0
        // node.expression.callee.params.length = 0
      },
    })
  }

  /**
   * @description 将对象['属性'] 改为对象.属性
   */
  changeObjectAccessMode() {
    traverse(this.ast, {
      MemberExpression(path) {
        if (t.isStringLiteral(path.node.property)) {
          let name = path.node.property.value
          path.node.property = t.identifier(name)
          path.node.computed = false
        }
      },
    })
  }

  /**
   * @description 将字符串和数值 **常量** 直接替换对应的变量引用地方
   */
  constantReplace() {
    traverse(this.ast, {
      'AssignmentExpression|VariableDeclarator'(path) {
        let name, initValue
        if (path.isAssignmentExpression()) {
          name = path.node.left.name
          initValue = path.node.right
        } else {
          name = path.node.id.name
          initValue = path.node.init
        }

        if (t.isStringLiteral(initValue) || t.isNumericLiteral(initValue)) {
          let binding = path.scope.getBinding(name)

          if (
            binding &&
            binding.constant &&
            binding.constantViolations.length == 0
          ) {
            for (let i = 0; i < binding.referencePaths.length; i++) {
              binding.referencePaths[i].replaceWith(initValue)
            }
            path.remove()
          }
        }
      },
    })
  }

  /**
   * @description 计算二项式字面量
   * @example
   * 1 + 2   "debu" + "gger"
   * ⬇️
   * 3        "debugger"
   */
  calcBinary() {
    traverse(this.ast, {
      BinaryExpression(path) {
        const { left, right } = path.node
        const hasIdentifier = [left, right].some((a) => t.isIdentifier(a))
        if (hasIdentifier) return
        if (t.isLiteral(left) && t.isLiteral(right)) {
          const { confident, value } = path.evaluate()
          confident && path.replaceWith(t.valueToNode(value))
          path.skip()
        }
      },
    })
  }

  /**
   * @description 计算布尔值
   * @example
   * !![] ---> true    ![] ---> false
   */
  calcBoolean() {
    traverse(this.ast, {
      UnaryExpression(path) {
        if (path.node.operator !== '!') return // 避免判断成 void

        // 判断第二个符号是不是!
        if (t.isUnaryExpression(path.node.argument)) {
          if (t.isArrayExpression(path.node.argument.argument)) {
            // !![]
            if (path.node.argument.argument.elements.length == 0) {
              path.replaceWith(t.booleanLiteral(true))
              path.skip()
            }
          }
        } else if (t.isArrayExpression(path.node.argument)) {
          // ![]
          if (path.node.argument.elements.length == 0) {
            path.replaceWith(t.booleanLiteral(false))
            path.skip()
          }
        } else if (t.isNumericLiteral(path.node.argument)) {
          // !0 or !1
          if (path.node.argument.value === 0)
            path.replaceWith(t.booleanLiteral(true))
          else if (path.node.argument.value === 1)
            path.replaceWith(t.booleanLiteral(false))
        } else {
        }
      },
    })
  }

  /**
   * @description	清理无用变量与函数
   */
  removeUnusedVariables() {
    traverse(this.ast, {
      VariableDeclarator(path) {
        const { id, init } = path.node
        if (
          !(
            t.isLiteral(init) ||
            t.isObjectExpression(init) ||
            t.isFunctionExpression(init)
          )
        )
          return

        const binding = path.scope.getBinding(id.name)
        if (!binding || binding.constantViolations.length > 0) return

        if (binding.referencePaths.length > 0) return
        path.remove()
      },
      FunctionDeclaration(path) {
        const binding = path.scope.getBinding(path.node.id.name)
        if (!binding || binding.constantViolations.length > 0) return

        if (binding.referencePaths.length > 0) return
        path.remove()
      },
    })
  }

  /**
   * @description 剔除始终不会执行的代码块
   * @example if(false){ }
   */
  removeUnusedBlock() {
    traverse(this.ast, {
      IfStatement(path) {
        if (t.isBooleanLiteral(path.node.test)) {
          if (path.node.test.value) {
            path.replaceInline(path.node.consequent.body)
          } else {
            path.replaceInline(path.node.alternate.body)
          }
        }
      },
    })
  }

  /**
   * @description 清理十六进制编码
   * @example '\x49\x63\x4b\x72\x77\x70\x2f\x44\x6c\x67\x3d\x3d' ---> "IcKrwp/Dlg=="
   */
  deleteExtra() {
    traverse(this.ast, {
      StringLiteral(path) {
        delete path.node.extra
      },
      NumericLiteral(path) {
        delete path.node.extra
      },
    })
  }

  /**
   * @description 给关键函数、标识符 设置注释
   * @example // TOLOOK
   */
  addComments(keywords = [], label = ' TOLOOK') {
    const defaultKeywords = ['debugger']
    keywords = [
      ...new Set([...keywords.map((k) => k.toLowerCase()), ...defaultKeywords]),
    ]

    traverse(this.ast, {
      DebuggerStatement(path) {
        // 如果已注释,则跳过
        const hasComment = path.node.leadingComments?.find(
          (c) => (c.value = label),
        )
        if (hasComment) return

        path.addComment('leading', label, true)
      },
      CallExpression(path) {
        if (path.node.callee.type === 'MemberExpression') {
          if (
            !['setTimeout', 'setInterval'].includes(
              path.node.callee.property?.value,
            )
          )
            return
          path.addComment('leading', label, true)
          return
        }

        if (!['setTimeout', 'setInterval'].includes(path.node.callee.name))
          return
        path.addComment('leading', label, true)
      },
      StringLiteral(path) {
        if (keywords.includes(path.node.value.toLowerCase())) {
          const statementPath = path.findParent((p) => p.isStatement())
          if (statementPath) statementPath.addComment('leading', label, true)
          else path.addComment('leading', label, true)
        }
      },
      Identifier(path) {
        const name = path.node.name
        if (keywords.includes(name.toLowerCase())) {
          const statementPath = path.findParent((p) => p.isStatement())
          if (statementPath) statementPath.addComment('leading', label, true)
          else path.addComment('leading', label, true)
        }
      },
    })
  }

  /**
   * @description 优化变量名
   * @example catch (_0x292610) {} ---> 如 catch (error) {}
   * @deprecated
   */
  renameIdentifier() {
    let code = this.code
    let newAst = parser.parse(code)
    traverse(newAst, {
      'Program|FunctionExpression|FunctionDeclaration'(path) {
        path.traverse({
          Identifier(p) {
            path.scope.rename(
              p.node.name,
              path.scope.generateUidIdentifier('_0xabc').name,
            )
          },
        })
      },
    })
    this.ast = newAst
  }
}

module.exports = { Deob }