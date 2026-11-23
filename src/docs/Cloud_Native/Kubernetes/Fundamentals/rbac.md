# RBAC

## 创建用户

[证书签名请求 | Kubernetes](https://kubernetes.io/zh-cn/docs/reference/access-authn-authz/certificate-signing-requests/#normal-user)

假设用户名为 `devopstales`, 生成 private key (`.pem`文件), 生成证书请求 (`.csr`文件) 

> O=组织信息，CN=用户名

```bash
openssl genrsa -out devopstales.pem
openssl req -new -key devopstales.pem -out devopstales.csr -subj "/CN=devopstales/O=devops-groupe"
```



对 csr 进行base64

```bash
cat devopstales.csr | base64 | tr -d '\n'
```

把刚刚得到的 字符串 贴到 request 中, 然后创建 `CertificateSigningRequest`

```yaml
apiVersion: certificates.k8s.io/v1beta1
kind: CertificateSigningRequest
metadata:
  name: user-request-devopstales
spec:
  groups:
  - system:authenticated
  request: LS0tLS1CRUdJTi...
  usages:
  - digital signature
  - key encipherment
  - client auth
```



然后 approve 它

```bash
kubectl create -f devopstales-csr.yaml
kubectl certificate approve user-request-devopstales
```

然后获取 证书

```bash
kubectl get csr user-request-devopstales -o jsonpath='{.status.certificate}' | base64 -d > devopstales-user.crt
```



然后创建对应的 kubeconfig 文件

```bash
kubectl --kubeconfig ./config-devopstales config set-cluster preprod --insecure-skip-tls-verify=true --server=https://KUBERNETES-API-ADDRESS
kubectl --kubeconfig ./config-devopstales config set-credentials devopstales --client-certificate=devopstales-user.crt --client-key=devopstales.pem --embed-certs=true
kubectl --kubeconfig ./config-devopstales config set-context default --cluster=preprod --user=devopstales
kubectl --kubeconfig ~/.kube/config-devopstales config use-context default
```



最后创建 role/rolebinding

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: devopstales-ns
spec: {}
status: {}
---
kind: Role
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: devopstales
  namespace: devopstales-ns
rules:
- apiGroups: ["", "extensions", "apps"]
  resources: ["*"]
  verbs: ["*"]
- apiGroups: ["batch"]
  resources:
  - jobs
  - cronjobs
  verbs: ["*"]
---
kind: RoleBinding
apiVersion: rbac.authorization.k8s.io/v1
metadata:
  name: devopstales
  namespace: devopstales-ns
subjects:
- kind: User
  name: devopstales
  apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: devopstales
```

## 用户组

用户组也是一个用户, 创建用户组还是要重复以上过程.

如果想要把某个用户划到用户组里, 需要在创建 `CertificateSigningRequest`时, 设置一下 `groups`, 例如:

```yaml
apiVersion: certificates.k8s.io/v1beta1
kind: CertificateSigningRequest
metadata:
  name: user-request-devopstales
spec:
  groups:
  - mygroup
  request: LS0tLS1CRUdJTi...
  usages:
  - digital signature
  - key encipherment
  - client auth
```

